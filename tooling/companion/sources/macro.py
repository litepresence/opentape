"""Macro / rates & derivatives source for the Opentape companion.

Keyless, stdlib-only (urllib, json, csv, io, datetime, calendar, re).

Venues:
  ECB-FX         ECB euro foreign-exchange reference rates (SDMX-JSON, daily)
  ECB-YC         ECB euro-area par-yield curves + IRS country 10Y (SDMX-JSON)
  Binance-Derivs Binance USDⓈ-M futures funding-rate + open-interest history
  Stooq          Stooq CSV daily/weekly fallback (degraded / throttled)

Live-only honesty: every fetch raises Exception(detail) on failure; Stooq
problems never affect the other venues (each venue fetches independently).
No keyed APIs (FRED / EIA / CoinGlass stay out by design).
"""

import calendar
import csv
import io
import json
import re
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

SOURCE = 'macro'
LABEL = 'Rates & Derivatives'
INTERVALS = ['1h', '1d', '1wk']
STREAM = {
    'mode': 'poll',
    'cadence': 3600,
    'note': ('ECB/Stooq are daily snapshots; Binance funding+OI poll ~1h. '
             'Stooq is a degraded/throttled fallback and never blocks other venues.'),
}

VENUE_INTERVALS = {
    'ECB-FX': ['1d', '1wk'],        # daily native; 1wk resampled from daily
    'ECB-YC': ['1d', '1wk'],        # daily native; 1wk resampled from daily
    'Binance-Derivs': ['1h', '1d'],  # OI hist periods; funding is ~8h native
    'Stooq': ['1d', '1wk'],         # Stooq i=d / i=w
}

STOOQ_NOTE = ('degraded/throttled fallback: rate-limited upstream, '
              'EOD only, never fails other venues')

ECB_BASE = 'https://data-api.ecb.europa.eu/service/data'
ECB_FX_WILDCARD = ECB_BASE + '/EXR/D..EUR.SP00.A?format=jsondata'

BIN_FAPI = 'https://fapi.binance.com'

YC_TENORS = ['1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y']
IRS_COUNTRIES = ['DE', 'FR', 'IT', 'ES']

_FX_SYMBOL_RE = re.compile(r'^[A-Z]{3}/EUR$')
_YC_SYMBOL_RE = re.compile(r'^EUR(\d+Y)$')
_IRS_SYMBOL_RE = re.compile(r'^([A-Z]{2})10Y-IRS$')
_BIN_SYMBOL_RE = re.compile(r'^([A-Z0-9]{1,20})USDT(?::(OI))?$')
_STOOQ_SYMBOL_RE = re.compile(r'^[a-z0-9.^=_/\-]{1,32}$')

_UA = {'User-Agent': 'opentape-companion/1.0 (macro source; keyless)'}
_HTTP_TIMEOUT = 15


# ---------------------------------------------------------------- venues ---

def venues():
    return [
        {'id': 'ECB-FX', 'label': 'ECB FX Reference'},
        {'id': 'ECB-YC', 'label': 'ECB Yield Curves'},
        {'id': 'Binance-Derivs', 'label': 'Binance Derivatives'},
        {'id': 'Stooq', 'label': 'Stooq (fallback)', 'note': STOOQ_NOTE},
    ]


# ------------------------------------------------------- pure URL builders ---

def ecb_fx_url(ccy):
    """Single-currency EXR reference-rate query, e.g. D.USD.EUR.SP00.A."""
    return ECB_BASE + '/EXR/D.%s.EUR.SP00.A?format=jsondata' % ccy


def ecb_yc_url(tenor):
    """Par-yield curve query, e.g. ...SV_C_YM.SR_10Y for tenor '10Y'."""
    return ECB_BASE + '/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_%s?format=jsondata' % tenor


def ecb_irs_url(country):
    """Country 10Y IRS query (best-effort key layout for the IRS dataflow)."""
    return (ECB_BASE + '/IRS/M.%s.L.EUR.4F.G_N_A.SV_C_YM.SR_10Y?format=jsondata'
            % country)


def binance_funding_url(symbol, limit):
    q = urllib.parse.urlencode({'symbol': symbol, 'limit': limit})
    return BIN_FAPI + '/fapi/v1/fundingRate?' + q


def binance_oi_hist_url(symbol, period, limit):
    q = urllib.parse.urlencode({'symbol': symbol, 'period': period, 'limit': limit})
    return BIN_FAPI + '/futures/data/openInterestHist?' + q


def binance_oi_snapshot_url(symbol):
    return BIN_FAPI + '/fapi/v1/openInterest?' + urllib.parse.urlencode({'symbol': symbol})


def stooq_url(symbol, d1, d2, freq):
    q = urllib.parse.urlencode({'s': symbol, 'd1': d1, 'd2': d2, 'i': freq})
    return 'https://stooq.com/q/d/l/?' + q


# ------------------------------------------------------------- pure parse ---

def _period_to_ms(period):
    """'YYYY-MM-DD' (or 'YYYY-MM') -> epoch ms at UTC midnight / month start."""
    period = period.strip()
    try:
        if len(period) == 7:  # YYYY-MM (e.g. monthly IRS vintages)
            dt = datetime(int(period[0:4]), int(period[5:7]), 1)
        else:  # YYYY-MM-DD
            dt = datetime(int(period[0:4]), int(period[5:7]), int(period[8:10]))
    except (ValueError, IndexError):
        raise ValueError('unparseable TIME_PERIOD %r' % period)
    return calendar.timegm(dt.replace(tzinfo=timezone.utc).timetuple()) * 1000


def _obs_number(raw):
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    s = str(raw).strip()
    if s in ('', '-', 'NaN', 'N/A', 'null', 'None'):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_sdmx_json(doc):
    """Parse SDMX-JSON generically -> {series_key: [(period, value), ...]}.

    Handles 'dataSets'/'datasets'/'data', 'observations'/'obs' value lists,
    TIME_PERIOD values as {id}/{name} dicts or plain strings. Missing /
    non-numeric observations are skipped.
    """
    if not isinstance(doc, dict):
        raise ValueError('SDMX-JSON must be an object')
    datasets = doc.get('dataSets', doc.get('datasets', doc.get('data')))
    if isinstance(datasets, dict):
        datasets = [datasets]
    if not datasets:
        raise ValueError('SDMX-JSON has no datasets')
    ds = datasets[0]
    series = ds.get('series', {})
    if not isinstance(series, dict):
        raise ValueError('SDMX-JSON dataset has no series map')

    struct = doc.get('structure', {}) or {}
    dims = struct.get('dimensions', {}) or {}
    obs_dims = dims.get('observation', dims.get('Observation', [])) or []
    periods = []
    for dim in obs_dims:
        if not isinstance(dim, dict):
            continue
        if dim.get('id') == 'TIME_PERIOD' or dim.get('role') == 'TIME_PERIOD':
            for v in dim.get('values', []) or []:
                if isinstance(v, dict):
                    periods.append(str(v.get('id', v.get('name', ''))))
                else:
                    periods.append(str(v))
            break
    if not periods:  # generic fallback: some feeds nest values under 'dimension'
        dim2 = (struct.get('dimensions') or {})
        if isinstance(dim2, dict):
            for key in ('TIME_PERIOD', 'time', 'TIME'):
                if key in dim2 and isinstance(dim2[key], list):
                    periods = [str(v.get('id', v) if isinstance(v, dict) else v)
                               for v in dim2[key]]
                    break

    out = {}
    for skey, sdata in series.items():
        if not isinstance(sdata, dict):
            continue
        obs = sdata.get('observations', sdata.get('obs', {}))
        points = []
        if isinstance(obs, dict):
            for idx, val in obs.items():
                # SDMX-JSON observation value is a list [value, attributes...]
                raw = val[0] if isinstance(val, (list, tuple)) and val else val
                try:
                    period = periods[int(idx)]
                except (ValueError, IndexError):
                    continue
                num = _obs_number(raw)
                if num is None:
                    continue
                points.append((period, num))
        elif isinstance(obs, list):
            for idx, val in enumerate(obs):
                raw = val[0] if isinstance(val, (list, tuple)) and val else val
                if idx >= len(periods):
                    break
                num = _obs_number(raw)
                if num is None:
                    continue
                points.append((periods[idx], num))
        out[str(skey)] = points
    return out


def sdmx_series_to_candles(points, limit=300):
    """(period, value) pairs -> ascending daily-line candles {o=h=l=c, v:0}."""
    rows = []
    for period, value in points:
        try:
            t = _period_to_ms(period)
        except ValueError:
            continue
        v = float(value)
        rows.append({'t': t, 'o': v, 'h': v, 'l': v, 'c': v, 'v': 0})
    rows.sort(key=lambda r: r['t'])
    return rows[-max(1, min(limit, 1000)):] if rows else []


def parse_funding_rows(rows, limit=300):
    """Binance /fundingRate rows -> ascending candle-ish records."""
    out = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        t = r.get('fundingTime', r.get('funding_time', r.get('t')))
        rate = _obs_number(r.get('fundingRate', r.get('funding_rate', r.get('c'))))
        if t is None or rate is None:
            continue
        try:
            t = int(t)
        except (ValueError, TypeError):
            continue
        out.append({'t': t, 'o': rate, 'h': rate, 'l': rate, 'c': rate, 'v': 0})
    out.sort(key=lambda r: r['t'])
    return out[-max(1, min(limit, 1000)):] if out else []


def parse_oi_rows(rows, limit=300):
    """Binance openInterestHist rows -> ascending candle-ish records."""
    out = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        t = r.get('timestamp', r.get('time', r.get('t')))
        val = _obs_number(r.get('sumOpenInterestValue',
                               r.get('sumOpenInterest', r.get('openInterest'))))
        if t is None or val is None:
            continue
        try:
            t = int(t)
        except (ValueError, TypeError):
            continue
        out.append({'t': t, 'o': val, 'h': val, 'l': val, 'c': val, 'v': 0})
    out.sort(key=lambda r: r['t'])
    return out[-max(1, min(limit, 1000)):] if out else []


def parse_oi_snapshot(obj):
    """Binance /openInterest snapshot dict -> single candle record."""
    if not isinstance(obj, dict):
        raise ValueError('open-interest snapshot must be an object')
    val = _obs_number(obj.get('openInterest'))
    if val is None:
        raise ValueError('open-interest snapshot has no openInterest')
    t = obj.get('time')
    if t is None:
        t = calendar.timegm(datetime.now(timezone.utc).timetuple()) * 1000
    return {'t': int(t), 'o': val, 'h': val, 'l': val, 'c': val, 'v': 0}


def parse_stooq_csv(text, limit=300):
    """Stooq q/d/l CSV (Date,Open,High,Low,Close,Volume) -> ascending candles."""
    if not text or not text.strip():
        raise ValueError('empty Stooq CSV')
    reader = csv.DictReader(io.StringIO(text.strip()))
    if not reader.fieldnames or reader.fieldnames[0].strip().lower() != 'date':
        raise ValueError('unexpected Stooq CSV header: %r' % (reader.fieldnames,))
    rows = []
    for rec in reader:
        try:
            day = (rec.get('Date') or rec.get('date') or '').strip()
            t = _period_to_ms(day)
            o = _obs_number(rec.get('Open'))
            h = _obs_number(rec.get('High'))
            l = _obs_number(rec.get('Low'))
            c = _obs_number(rec.get('Close'))
        except (ValueError, AttributeError):
            continue
        if None in (o, h, l, c):
            continue
        vol = _obs_number(rec.get('Volume')) or 0
        rows.append({'t': t, 'o': o, 'h': h, 'l': l, 'c': c, 'v': vol})
    rows.sort(key=lambda r: r['t'])
    if not rows:
        raise ValueError('Stooq CSV has no parseable rows (throttled?)')
    return rows[-max(1, min(limit, 1000)):]


def resample_weekly(daily):
    """Daily candles -> ISO-week candles (o=first, h=max, l=min, c=last)."""
    buckets = {}
    order = []
    for r in daily:
        dt = datetime.fromtimestamp(r['t'] / 1000, tz=timezone.utc).date()
        iso = dt.isocalendar()  # (year, week, weekday)
        key = (iso[0], iso[1])
        if key not in buckets:
            buckets[key] = []
            order.append(key)
        buckets[key].append(r)
    out = []
    for key in order:
        rs = buckets[key]
        out.append({
            't': rs[0]['t'],
            'o': rs[0]['o'],
            'h': max(x['h'] for x in rs),
            'l': min(x['l'] for x in rs),
            'c': rs[-1]['c'],
            'v': sum(x.get('v', 0) or 0 for x in rs),
        })
    return out


# --------------------------------------------------------------- registry ---

_FX_MAJORS = [
    ('USD/EUR', 'US Dollar / Euro'), ('JPY/EUR', 'Japanese Yen / Euro'),
    ('GBP/EUR', 'British Pound / Euro'), ('CHF/EUR', 'Swiss Franc / Euro'),
    ('CNY/EUR', 'Chinese Yuan / Euro'), ('AUD/EUR', 'Australian Dollar / Euro'),
    ('CAD/EUR', 'Canadian Dollar / Euro'), ('SEK/EUR', 'Swedish Krona / Euro'),
    ('NZD/EUR', 'New Zealand Dollar / Euro'), ('MXN/EUR', 'Mexican Peso / Euro'),
    ('SGD/EUR', 'Singapore Dollar / Euro'), ('HKD/EUR', 'Hong Kong Dollar / Euro'),
    ('NOK/EUR', 'Norwegian Krone / Euro'), ('DKK/EUR', 'Danish Krone / Euro'),
    ('ZAR/EUR', 'South African Rand / Euro'), ('BRL/EUR', 'Brazilian Real / Euro'),
    ('INR/EUR', 'Indian Rupee / Euro'), ('KRW/EUR', 'South Korean Won / Euro'),
]

_YC_NAMES = {t: 'Euro area par yield %s' % t.replace('Y', '-year') for t in YC_TENORS}
_IRS_NAMES = {'%s10Y-IRS' % c: '%s 10Y interest-rate swap' % c for c in IRS_COUNTRIES}

_TOP_FUNDING = [
    ('BTCUSDT', 'Bitcoin USDT perpetual'), ('ETHUSDT', 'Ethereum USDT perpetual'),
    ('SOLUSDT', 'Solana USDT perpetual'), ('BNBUSDT', 'BNB USDT perpetual'),
    ('XRPUSDT', 'XRP USDT perpetual'), ('DOGEUSDT', 'Dogecoin USDT perpetual'),
    ('ADAUSDT', 'Cardano USDT perpetual'), ('AVAXUSDT', 'Avalanche USDT perpetual'),
    ('LINKUSDT', 'Chainlink USDT perpetual'), ('ARBUSDT', 'Arbitrum USDT perpetual'),
]

_STOOQ_TOP = [
    ('spy.us', 'SPDR S&P 500'), ('qqq.us', 'Invesco QQQ'),
    ('aapl.us', 'Apple'), ('msft.us', 'Microsoft'),
    ('eurusd', 'Euro / US Dollar'), ('xauusd', 'Gold / US Dollar'),
    ('btcusd', 'Bitcoin / US Dollar'), ('^spx', 'S&P 500 index'),
]


def _registry_for(venue):
    if venue == 'ECB-FX':
        return [{'symbol': s, 'name': n} for s, n in _FX_MAJORS]
    if venue == 'ECB-YC':
        items = [{'symbol': 'EUR' + t, 'name': _YC_NAMES[t]} for t in YC_TENORS]
        items += [{'symbol': s, 'name': n} for s, n in sorted(_IRS_NAMES.items())]
        return items
    if venue == 'Binance-Derivs':
        return [{'symbol': s, 'name': n} for s, n in _TOP_FUNDING]
    if venue == 'Stooq':
        return [{'symbol': s, 'name': n} for s, n in _STOOQ_TOP]
    raise Exception("unknown venue %r for source 'macro'; venues: ECB-FX, ECB-YC, Binance-Derivs, Stooq"
                    % venue)


def _passthrough(venue, query):
    """Format an arbitrary query as a venue symbol, or None if invalid."""
    q = (query or '').strip()
    if not q:
        return None
    if venue == 'ECB-FX':
        ccy = q.split('/')[0].strip().upper()
        if re.fullmatch(r'[A-Z]{3}', ccy):
            return {'symbol': ccy + '/EUR', 'name': ccy + ' / Euro (ECB reference)'}
    elif venue == 'ECB-YC':
        u = q.upper().replace(' ', '')
        if _YC_SYMBOL_RE.match(u):
            tenor = u[3:]
            if tenor in YC_TENORS:
                return {'symbol': u, 'name': _YC_NAMES[tenor]}
        m = re.fullmatch(r'([A-Z]{2})-?IRS', u) or re.fullmatch(r'([A-Z]{2})10Y-?IRS', u)
        if m and m.group(1) in IRS_COUNTRIES:
            sym = m.group(1) + '10Y-IRS'
            return {'symbol': sym, 'name': _IRS_NAMES[sym]}
    elif venue == 'Binance-Derivs':
        u = q.upper().replace('/', '').replace(' ', '')
        oi = u.endswith(':OI')
        if oi:
            u = u[:-3]
        if not u.endswith('USDT'):
            u += 'USDT'
        if _BIN_SYMBOL_RE.match(u + (':OI' if oi else '')):
            base = u[:-4]
            label = base + ' USDT perpetual' + (' (open interest)' if oi else ' (funding rate)')
            return {'symbol': u + (':OI' if oi else ''), 'name': label}
    elif venue == 'Stooq':
        s = q.lower()
        if _STOOQ_SYMBOL_RE.match(s):
            return {'symbol': s, 'name': s + ' (Stooq)'}
    return None


def search(venue, query):
    _registry_for(venue)  # validates venue first
    q = (query or '').strip().lower()
    reg = _registry_for(venue)
    if not q:
        return reg[:20]
    hits = [e for e in reg if q in e['symbol'].lower() or q in e['name'].lower()]
    if not any(e['symbol'].lower() == q or e['symbol'].lower() == q.replace('/', '')
               for e in hits):
        pt = _passthrough(venue, query)
        if pt and all(e['symbol'] != pt['symbol'] for e in hits):
            hits.append(pt)
    return hits[:50]


# ------------------------------------------------------------------ fetch ---

def _http_get(url):
    req = urllib.request.Request(url, headers=_UA)
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return resp.read().decode('utf-8', 'replace')
    except Exception as e:
        raise Exception('upstream fetch failed (%s): %s' % (url.split('?')[0], e))


def _check_interval(venue, interval):
    if interval not in INTERVALS:
        raise Exception("unsupported interval %r for source 'macro'; supported: %s"
                        % (interval, INTERVALS))
    supported = VENUE_INTERVALS.get(venue)
    if supported is None:
        raise Exception("unknown venue %r for source 'macro'; venues: %s"
                        % (venue, sorted(VENUE_INTERVALS)))
    if interval not in supported:
        raise Exception("unsupported interval %r for venue '%s'; supported: %s"
                        % (interval, venue, supported))


def _clamp_limit(limit):
    try:
        limit = int(limit)
    except (ValueError, TypeError):
        limit = 300
    return max(1, min(limit, 1000))


def _ecb_candles(url, interval, limit):
    try:
        doc = json.loads(_http_get(url))
    except Exception as e:
        raise Exception('ECB SDMX fetch failed: %s' % e)
    try:
        parsed = parse_sdmx_json(doc)
    except ValueError as e:
        raise Exception('ECB SDMX parse failed: %s' % e)
    if not parsed:
        raise Exception('ECB returned no series (unknown currency/tenor?)')
    # Single-series queries return one key; wildcard takes the first series.
    points = next(iter(parsed.values()))
    if not points:
        raise Exception('ECB series is empty')
    candles = sdmx_series_to_candles(points, limit=max(limit, 1500) if interval == '1wk' else limit)
    if interval == '1wk':
        candles = resample_weekly(candles)[-limit:]
    return candles


def candles(venue, symbol, interval, limit=300):
    _check_interval(venue, interval)
    limit = _clamp_limit(limit)

    if venue == 'ECB-FX':
        sym = (symbol or '').upper().replace(' ', '')
        if not _FX_SYMBOL_RE.match(sym):
            raise Exception("bad ECB-FX symbol %r; use 'XXX/EUR', e.g. 'USD/EUR'" % symbol)
        return _ecb_candles(ecb_fx_url(sym.split('/')[0]), interval, limit)

    if venue == 'ECB-YC':
        sym = (symbol or '').upper().replace(' ', '')
        m = _YC_SYMBOL_RE.match(sym)
        mi = _IRS_SYMBOL_RE.match(sym)
        if m and m.group(1) in YC_TENORS:
            return _ecb_candles(ecb_yc_url(m.group(1)), interval, limit)
        if mi and mi.group(1) in IRS_COUNTRIES:
            return _ecb_candles(ecb_irs_url(mi.group(1)), interval, limit)
        raise Exception("bad ECB-YC symbol %r; use 'EUR10Y' (tenors %s) or 'DE10Y-IRS' (%s)"
                        % (symbol, YC_TENORS, IRS_COUNTRIES))

    if venue == 'Binance-Derivs':
        sym = (symbol or '').upper().replace('/', '').replace(' ', '')
        m = _BIN_SYMBOL_RE.match(sym)
        if not m:
            raise Exception("bad Binance-Derivs symbol %r; use 'XXXUSDT' with optional ':OI'" % symbol)
        base, oi = m.group(1), m.group(2)
        pair = base + 'USDT'
        if not oi:  # funding-rate history (~8h native spacing)
            try:
                rows = json.loads(_http_get(binance_funding_url(pair, min(limit, 1000))))
            except Exception as e:
                raise Exception('Binance funding fetch failed for %s: %s' % (pair, e))
            out = parse_funding_rows(rows, limit)
            if not out:
                raise Exception('Binance returned no funding rows for %s' % pair)
            return out
        period = '1h' if interval == '1h' else '1d'
        try:
            rows = json.loads(_http_get(binance_oi_hist_url(pair, period, min(limit, 500))))
            out = parse_oi_rows(rows, limit)
        except Exception:
            out = []
        if not out:  # snapshot fallback: still real data, single point
            try:
                snap = json.loads(_http_get(binance_oi_snapshot_url(pair)))
                return [parse_oi_snapshot(snap)]
            except Exception as e:
                raise Exception('Binance open-interest fetch failed for %s: %s' % (pair, e))
        return out

    if venue == 'Stooq':
        sym = (symbol or '').strip().lower()
        if not _STOOQ_SYMBOL_RE.match(sym):
            raise Exception("bad Stooq symbol %r; e.g. 'aapl.us', 'eurusd', '^spx'" % symbol)
        freq = 'd' if interval == '1d' else 'w'
        span_days = limit + 60 if freq == 'd' else limit * 7 + 60
        today = date.today()
        d2 = today.strftime('%Y%m%d')
        d1 = (today - timedelta(days=min(span_days, 3650))).strftime('%Y%m%d')
        try:
            text = _http_get(stooq_url(sym, d1, d2, freq))
        except Exception as e:
            raise Exception('Stooq fetch failed for %s (%s)' % (sym, e))
        if 'Exceeded' in text[:200] or 'limit' in text[:200].lower() and len(text) < 200:
            raise Exception('Stooq throttled (%s); retry later' % STOOQ_NOTE)
        try:
            return parse_stooq_csv(text, limit)
        except ValueError as e:
            raise Exception('Stooq parse failed for %s: %s (%s)' % (sym, e, STOOQ_NOTE))

    raise Exception("unknown venue %r for source 'macro'" % venue)

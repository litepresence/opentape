"""Korea (KRX: KOSPI / KOSDAQ) companion source.

Stdlib only: urllib, json, datetime (plus re/time, also stdlib). No
third-party imports, no keys, no secrets.

Primary: Naver Finance keyless routes.
  chart    GET https://api.finance.naver.com/siseJson.naver
           ?symbol=005930&requestType=1&startTime=YYYYMMDD
           &endTime=YYYYMMDD&timeframe=day
           (requestType=0&count=N variant; timeframe=day|week|month;
           minute is count-bound only -- see MINUTE NOTE below).
  polling  GET https://polling.finance.naver.com/api/realtime/domestic/stock/005930
           (comma-batch supported: .../stock/005930,000660).

  Naver chart closes are adjusted (Naver default); prices are KRW.
  Dates are session dates; date-only values normalize to UTC midnight
  (ms since epoch), matching the other EOD sources in this tree.

Fallback: Yahoo Finance v8/chart (005930.KS / 005930.KQ, delayed ~15min)
  when Naver hiccups. Provider trail: candles() returns a bare list per
  the server contract, so the trail cannot ride in a result meta -- it is
  exposed via last_fallback() and documented here. quote() returns a dict
  and therefore DOES carry a 'fallback' list. The server envelope
  meta.fallback stays server-owned (disk-cache marker).

MINUTE NOTE: Naver's minute leg is count-bound (requestType=0&count=N)
  with no stable date-range history product, so INTERVALS advertises only
  the three primary granularities. candles() still accepts '1m' best-effort
  through the count leg (unreachable via the server, which validates
  against INTERVALS first); anything else raises naming the supported list.

SEARCH CHOICE: Naver's autocomplete/search surface is undocumented and
  unstable, so search() is an offline code-pattern matcher (any 6-digit
  code -> KOSPI/KOSDAQ guess list) over a small curated majors table for
  name lookup. Documented here instead of wired to a scraping endpoint
  that could silently relabel the market.

Symbol form: 6-digit codes ('005930'); '.KS'/'.KQ' suffixes and 'KRX:'
  style prefixes are stripped. Venue/code-prefix matching is deliberately
  loose -- any valid 6-digit code is accepted under either venue, so a
  valid code is never rejected for a wrong venue guess.

Live-only honesty: every fetch raises Exception(detail) on failure and
  never substitutes another symbol -- the Yahoo leg covers the same KRX
  issuer under its .KS/.KQ ticker, which is the same market, not a
  substitute.
"""

import json
import re
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from urllib.error import HTTPError, URLError

SOURCE = 'korea'
LABEL = 'Korea (KOSPI/KOSDAQ)'
INTERVALS = ['1d', '1wk', '1mo']
STREAM = {'mode': 'poll', 'cadence': 60,
          'note': 'Naver polling realtime (~7s quote TTL); '
                  'Yahoo .KS/.KQ delayed ~15min fallback'}

NAVER_CHART_URL = 'https://api.finance.naver.com/siseJson.naver'
NAVER_POLL_URL = ('https://polling.finance.naver.com/api/realtime/'
                  'domestic/stock/')
YAHOO_HOSTS = ('query1.finance.yahoo.com', 'query2.finance.yahoo.com')

_HTTP_TIMEOUT = 12
_POLL_TTL = 7.0  # seconds; Naver polling snapshot cache (see quote())

_UA = {'User-Agent': 'opentape-companion/1.0 (+localhost)', 'Accept': '*/*'}

_VENUES = (
    ('KOSPI', 'KOSPI (KRX)'),
    ('KOSDAQ', 'KOSDAQ (KRX)'),
)
_SUPPORTED_VENUES = [v[0] for v in _VENUES]

# Best-effort minute leg (module-only; not advertised in INTERVALS).
_TIMEFRAMES = {'1d': 'day', '1wk': 'week', '1mo': 'month', '1m': 'minute'}
_YAHOO_INTERVALS = {'1d': '1d', '1wk': '1wk', '1mo': '1mo', '1m': '1m'}

_CODE_RE = re.compile(r'(\d{6})')
_DATE_RE = re.compile(r'^\d{8}$')
_ROW_SPLIT_RE = re.compile(r'\]\s*,\s*\[')
_FIELD_RE = re.compile(
    r"""'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(-?\d[\d,\.]*)""")

# Curated majors for offline name search (code, name).
KNOWN = [
    ('005930', 'Samsung Electronics'),
    ('000660', 'SK hynix'),
    ('005380', 'Hyundai Motor'),
    ('000270', 'Kia'),
    ('035420', 'NAVER'),
    ('035720', 'Kakao'),
    ('051910', 'LG Chem'),
    ('006400', 'Samsung SDI'),
    ('012330', 'Hyundai Mobis'),
    ('028260', 'Samsung C&T'),
    ('105560', 'KB Financial'),
    ('055550', 'Shinhan Financial'),
    ('017670', 'SK Telecom'),
    ('030200', 'KT'),
    ('096770', 'SK Innovation'),
    ('207940', 'Samsung Biologics'),
    ('068270', 'Celltrion'),
    ('323410', 'KakaoBank'),
    ('247540', 'EcoPro'),
    ('086520', 'EcoPro BM'),
]

_LAST_FALLBACK = []
_POLL_CACHE = {}  # code -> (expires_monotonic, quote_dict)


def venues():
    """Return [{'id', 'label'}] venue descriptors."""
    return [{'id': vid, 'label': vlabel} for vid, vlabel in _VENUES]


def last_fallback():
    """Provider trail of the most recent candles() call (e.g. ['naver'] or
    ['naver:<reason>', 'yahoo:005930.KS']). Pure accessor; see module docs
    for why the trail lives here instead of a result meta."""
    return list(_LAST_FALLBACK)


def _set_trail(trail):
    global _LAST_FALLBACK
    _LAST_FALLBACK = list(trail)


# ---------------------------------------------------------------------------
# Pure helpers: symbols / venues / intervals.
# ---------------------------------------------------------------------------

def normalize_code(symbol):
    """Extract the 6-digit KRX code from user input. Pure.

    Accepts '005930', '005930.KS', '005930.KQ', 'KRX:005930' and friends;
    raises with a reason when no 6-digit code is present. Never rejects a
    valid code for venue/prefix reasons (prefix matching is loose by
    design).
    """
    if symbol is None:
        raise Exception('korea: empty symbol (expected a 6-digit KRX code)')
    text = str(symbol).strip()
    if not text:
        raise Exception('korea: empty symbol (expected a 6-digit KRX code)')
    if len(text) > 64:
        raise Exception('korea: symbol too long (max 64 chars): %r' % (symbol,))
    match = _CODE_RE.search(text)
    if not match:
        raise Exception(
            "korea: unroutable symbol %r (expected a 6-digit KRX code "
            "like '005930')" % (symbol,))
    return match.group(1)


def check_venue(venue):
    """Normalize the venue; ''/None means venue-agnostic (same KRX feed).

    Raises naming the supported venues for anything else.
    """
    v = '' if venue is None else str(venue).strip().upper()
    if v in ('', 'KRX', 'KR'):
        return ''
    if v in _SUPPORTED_VENUES:
        return v
    raise Exception('korea: unknown venue %r; supported: %s'
                    % (venue, ', '.join(_SUPPORTED_VENUES)))


def validate_interval(interval):
    """Return the interval, or raise naming the supported list.

    '1m' is accepted best-effort (Naver count-bound minute leg); the
    advertised primary list is INTERVALS.
    """
    if interval in _TIMEFRAMES:
        return interval
    raise Exception('korea: unsupported interval %r; supported: %s'
                    % (interval, ', '.join(INTERVALS)))


def clamp_limit(limit):
    try:
        n = int(limit)
    except (TypeError, ValueError):
        raise Exception('korea: invalid limit %r; expected 1..1000' % (limit,))
    return max(1, min(1000, n))


# ---------------------------------------------------------------------------
# Pure helpers: numbers / dates.
# ---------------------------------------------------------------------------

def _fnum(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(',', '')
    if text in ('', '-', '--', 'null', 'None', 'NA'):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _date_to_ms(yyyymmdd):
    try:
        dt = datetime.strptime(yyyymmdd, '%Y%m%d')
    except ValueError:
        raise Exception('korea: unparseable date %r' % (yyyymmdd,))
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


def _window(limit, interval):
    """Pure date-window math -> (start_YYYYMMDD, end_YYYYMMDD).

    Over-fetches ~2x for weekends/holidays (Naver skips non-sessions),
    then trims to ``limit``.
    """
    n = clamp_limit(limit)
    today = date.today()
    if interval == '1d':
        days = n * 2 + 10
    elif interval == '1wk':
        days = n * 7 * 2 + 14
    else:
        days = n * 31 * 2 + 31
    start = today - timedelta(days=days)
    return (start.strftime('%Y%m%d'), today.strftime('%Y%m%d'))


# ---------------------------------------------------------------------------
# Naver chart URL builders (pure) + pseudo-JSON parser (pure).
# ---------------------------------------------------------------------------

def naver_chart_url(code, interval, start=None, end=None, count=None):
    """Build a Naver siseJson URL (requestType=1 date-range by default)."""
    timeframe = _TIMEFRAMES[validate_interval(interval)]
    params = {'symbol': code, 'timeframe': timeframe}
    if count is not None:
        params['requestType'] = 0
        params['count'] = clamp_limit(count)
    else:
        s, e = start, end
        if s is None or e is None:
            s, e = _window(300, interval if interval in INTERVALS else '1d')
        params['requestType'] = 1
        params['startTime'] = s
        params['endTime'] = e
    return NAVER_CHART_URL + '?' + urllib.parse.urlencode(params)


def _unescape(value):
    return value.replace("\\'", "'").replace('\\"', '"').replace('\\\\', '\\')


def parse_sise_json(text):
    """Parse Naver siseJson pseudo-JSON to ascending candles. Pure.

    Tolerant of single quotes, Korean header row(s) (any row whose first
    cell is not YYYYMMDD is skipped), comma-grouped numbers, missing
    volume, and out-of-order rows. Returns [] when no data rows survive;
    raises only when the body is not an array at all.
    """
    content = str(text or '').strip().rstrip(';').strip()
    if not content.startswith('['):
        raise Exception('korea: parse error (not a Naver siseJson array)')
    inner = content[1:]
    if inner.endswith(']'):
        inner = inner[:-1]
    if not inner.strip():
        return []
    out = []
    for chunk in _ROW_SPLIT_RE.split(inner):
        fields = []
        for single, double, number in _FIELD_RE.findall(chunk):
            if single:
                fields.append(_unescape(single))
            elif double:
                fields.append(_unescape(double))
            else:
                fields.append(number)
        if not fields:
            continue
        if not _DATE_RE.match(fields[0].strip()):
            continue  # Korean header row or junk row
        if len(fields) < 5:
            continue
        o, h, low, c = (_fnum(fields[1]), _fnum(fields[2]),
                        _fnum(fields[3]), _fnum(fields[4]))
        if o is None or h is None or low is None or c is None:
            continue
        v = _fnum(fields[5]) if len(fields) > 5 else 0.0
        out.append({'t': _date_to_ms(fields[0].strip()),
                    'o': o, 'h': h, 'l': low, 'c': c,
                    'v': v if v is not None else 0.0})
    by_t = {}
    for candle in out:
        by_t[candle['t']] = candle
    return [by_t[t] for t in sorted(by_t)]


# ---------------------------------------------------------------------------
# Naver polling parser (pure).
# ---------------------------------------------------------------------------

def _pick(row, *names):
    for name in names:
        if isinstance(row, dict) and row.get(name) is not None:
            return row[name]
    return None


def parse_polling(payload, code):
    """Decode a Naver polling body to a quote dict. Pure.

    Accepts both the documented long keys (closePrice/openPrice/...)
    and the short wire keys (nv/ov/hv/lv/aq/ms). Raises with a reason
    when the code is absent or the close is missing.
    """
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError as exc:
            raise Exception('korea: polling parse error (%s)' % exc)
    if not isinstance(payload, dict):
        raise Exception('korea: polling parse error (not an object)')
    datas = []
    try:
        areas = payload.get('result', {}).get('areas', [])
    except AttributeError:
        areas = []
    for area in areas or []:
        if isinstance(area, dict):
            for row in area.get('datas') or []:
                if isinstance(row, dict):
                    datas.append(row)
    if not datas and isinstance(payload.get('datas'), list):
        datas = [r for r in payload['datas'] if isinstance(r, dict)]
    row = None
    for candidate in datas:
        if str(candidate.get('cd', candidate.get('code', ''))) == code:
            row = candidate
            break
    if row is None and len(datas) == 1:
        only = datas[0]
        # Lone-row leniency only when the row carries no code identity;
        # a row explicitly labeled with a different code must never be
        # substituted (live-only honesty).
        if 'cd' not in only and 'code' not in only:
            row = only
    if row is None:
        raise Exception('korea: polling symbol %s not in response' % code)
    close = _fnum(_pick(row, 'closePrice', 'nv', 'now', 'close'))
    if close is None:
        raise Exception('korea: polling row for %s has no close' % code)
    quote = {'symbol': code, 'price': close}
    mapping = (('open', ('openPrice', 'ov', 'open')),
               ('high', ('highPrice', 'hv', 'high')),
               ('low', ('lowPrice', 'lv', 'low')),
               ('volume', ('accumulatedTradingVolume', 'aq', 'volume')),
               ('market_status', ('marketStatus', 'ms')),
               ('t', ('localTradedAt', 'ltt', 't')))
    for key, aliases in mapping:
        value = _pick(row, *aliases)
        if value is None:
            continue
        if key == 't':
            try:
                quote[key] = int(value)
            except (TypeError, ValueError):
                quote[key] = int(time.time() * 1000)
        elif key == 'market_status':
            quote[key] = str(value)
        else:
            num = _fnum(value)
            if num is not None:
                quote[key] = num
    quote.setdefault('t', int(time.time() * 1000))
    return quote


# ---------------------------------------------------------------------------
# Yahoo fallback (pure URL/parse + thin fetchers).
# ---------------------------------------------------------------------------

def yahoo_tickers(venue, code):
    """Candidate Yahoo tickers for a KRX code (venue-mapped first)."""
    if venue == 'KOSDAQ':
        return [code + '.KQ', code + '.KS']
    return [code + '.KS', code + '.KQ']


def yahoo_chart_url(host, ticker, interval, range_):
    """Pure v8/chart URL builder (query1 tried first, query2 on failure)."""
    q = urllib.parse.urlencode({'interval': _YAHOO_INTERVALS[interval],
                                'range': range_})
    return ('https://%s/v8/finance/chart/%s?%s'
            % (host, urllib.parse.quote(ticker, safe=''), q))


def yahoo_range(interval, limit):
    """Smallest Yahoo range covering ``limit`` bars of ``interval``."""
    if interval == '1m':
        return '5d'
    span = {'1d': 1, '1wk': 7, '1mo': 30}[interval] * clamp_limit(limit)
    for label, days in (('1mo', 30), ('3mo', 90), ('6mo', 180),
                        ('1y', 365), ('2y', 730), ('5y', 1825)):
        if days >= span:
            return label
    return 'max'


def parse_yahoo_chart(payload):
    """Decode a Yahoo v8/chart payload to ascending adjusted bars. Pure.

    Same-market fallback only (KRX issuer under .KS/.KQ); split/dividend
    adjustment mirrors the yahoo source (adjclose/close factor per bar).
    Raises on error objects; returns [] when no usable bars survive.
    """
    try:
        chart = payload['chart']
    except (TypeError, KeyError):
        raise Exception('korea: Yahoo parse error (not a chart payload)')
    if not isinstance(chart, dict):
        raise Exception('korea: Yahoo parse error (not a chart payload)')
    if chart.get('error'):
        err = chart['error']
        detail = err.get('description') or err.get('code') or err
        raise Exception('korea: Yahoo upstream error: %s' % detail)
    results = chart.get('result') or []
    if not results:
        raise Exception('korea: Yahoo empty response (unknown symbol?)')
    node = results[0] or {}
    stamps = node.get('timestamp') or []
    indicators = node.get('indicators') or {}
    quotes = indicators.get('quote') or [{}]
    quote = quotes[0] or {}
    adj_nodes = indicators.get('adjclose') or [{}]
    adj = (adj_nodes[0] or {}).get('adjclose') or []
    opens = quote.get('open') or []
    highs = quote.get('high') or []
    lows = quote.get('low') or []
    closes = quote.get('close') or []
    vols = quote.get('volume') or []
    bars = []
    for i, stamp in enumerate(stamps):
        o = opens[i] if i < len(opens) else None
        h = highs[i] if i < len(highs) else None
        low = lows[i] if i < len(lows) else None
        c = closes[i] if i < len(closes) else None
        if o is None or h is None or low is None or c is None:
            continue
        a = adj[i] if i < len(adj) else None
        factor = (a / c) if (a and c) else 1.0
        v = vols[i] if i < len(vols) and vols[i] is not None else 0
        bars.append({'t': int(stamp) * 1000,
                     'o': float(o) * factor, 'h': float(h) * factor,
                     'l': float(low) * factor, 'c': float(c) * factor,
                     'v': float(v)})
    bars.sort(key=lambda b: b['t'])
    return bars


# ---------------------------------------------------------------------------
# Transport (urllib only; _get seam keeps tests offline).
# ---------------------------------------------------------------------------

def _decode_body(raw):
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        return raw.decode('cp949', errors='replace')


def _fetch_text(url, _get=None):
    if _get is not None:
        body = _get(url)
        return body.decode('utf-8', errors='replace') if isinstance(
            body, (bytes, bytearray)) else str(body)
    req = urllib.request.Request(url, headers=dict(
        _UA, Referer='https://finance.naver.com'))
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return _decode_body(resp.read())
    except HTTPError as exc:
        raise Exception('korea: GET %s -> HTTP %s: %s'
                        % (url.split('?')[0], exc.code, exc.reason))
    except URLError as exc:
        raise Exception('korea: GET %s failed: %s'
                        % (url.split('?')[0], exc.reason))
    except (TimeoutError, OSError) as exc:
        raise Exception('korea: network error: %s' % exc)


def _fetch_json(url, _get=None):
    try:
        return json.loads(_fetch_text(url, _get))
    except ValueError as exc:
        raise Exception('korea: parse error: invalid JSON (%s)' % exc)


def _naver_candles(code, interval, limit, _get=None):
    if interval == '1m':
        url = naver_chart_url(code, interval, count=limit)
    else:
        start, end = _window(limit, interval)
        url = naver_chart_url(code, interval, start=start, end=end)
    bars = parse_sise_json(_fetch_text(url, _get))
    if not bars:
        raise Exception('korea: Naver empty response for %s (%s): '
                        'no candles returned' % (code, interval))
    return bars[-clamp_limit(limit):]


def _yahoo_candles(venue, code, interval, limit, _get=None):
    n = clamp_limit(limit)
    range_ = yahoo_range(interval, n)
    last_error = None
    for ticker in yahoo_tickers(venue, code):
        for host in YAHOO_HOSTS:
            url = yahoo_chart_url(host, ticker, interval, range_)
            try:
                bars = parse_yahoo_chart(_fetch_json(url, _get))
            except Exception as exc:
                last_error = exc
                continue
            if bars:
                return bars[-n:], ticker
            last_error = Exception(
                'korea: Yahoo empty response for %s' % ticker)
    raise last_error or Exception('korea: Yahoo fallback failed for %s' % code)


# ---------------------------------------------------------------------------
# Contract entry points.
# ---------------------------------------------------------------------------

def candles(venue, symbol, interval, limit=300, _get=None):
    """Return ascending [{t(ms),o,h,l,c,v}] for (venue, symbol, interval).

    Naver first, Yahoo .KS/.KQ second (same KRX issuer only). Raises with
    the combined reason when both legs fail; never substitutes another
    market. ``_get`` is a test seam (callable url -> raw body); the
    companion server calls with the four public arguments only.
    """
    validate_interval(interval)
    v = check_venue(venue)
    code = normalize_code(symbol)
    n = clamp_limit(limit)
    trail = []
    try:
        bars = _naver_candles(code, interval, n, _get)
        _set_trail(['naver'])
        return bars
    except Exception as exc:
        trail.append('naver: %s' % exc)
        naver_err = exc
    try:
        bars, used = _yahoo_candles(v, code, interval, n, _get)
        trail.append('yahoo: %s' % used)
        _set_trail(trail)
        return bars
    except Exception as exc:
        trail.append('yahoo: %s' % exc)
        _set_trail(trail)
        raise Exception('korea %s: Naver failed (%s); Yahoo fallback '
                        'failed (%s)' % (code, naver_err, exc))


def quote(venue, symbol, _get=None):
    """Spot quote via Naver polling (comma-batch capable), Yahoo fallback.

    Carries a 'fallback' provider trail list (the candles list shape
    cannot, so its trail lives in last_fallback() -- see module docs).
    Cached ~7s per code (TTL note in STREAM); the ``_get`` test seam
    bypasses the cache for determinism.
    """
    v = check_venue(venue)
    code = normalize_code(symbol)
    now = time.monotonic()
    if _get is None:
        hit = _POLL_CACHE.get(code)
        if hit and hit[0] > now:
            return dict(hit[1])
    try:
        payload = _fetch_json(NAVER_POLL_URL + code, _get)
        tick = parse_polling(payload, code)
        tick['fallback'] = []
        tick['provider'] = 'naver'
        if _get is None:
            _POLL_CACHE[code] = (now + _POLL_TTL, dict(tick))
        return tick
    except Exception as naver_err:
        pass
    try:
        bars, used = _yahoo_candles(v, code, '1d', 5, _get)
    except Exception as exc:
        raise Exception('korea quote %s: Naver polling failed (%s); '
                        'Yahoo fallback failed (%s)' % (code, naver_err, exc))
    if len(bars) < 2:
        raise Exception('korea quote %s: not enough Yahoo bars '
                        '(%d)' % (code, len(bars)))
    prev, last = bars[-2]['c'], bars[-1]['c']
    change = ((last - prev) / prev * 100.0) if prev else 0.0
    return {'symbol': code, 'ticker': used, 'price': last,
            'prev_close': prev, 'change_pct': change, 't': bars[-1]['t'],
            'fallback': ['yahoo: %s' % used], 'provider': 'yahoo'}


def match_code_pattern(query):
    """Offline code-pattern matcher for search(). Pure.

    A 6-digit code yields the venue guess list (KOSPI+KOSDAQ when no venue
    is pinned, else the pinned venue); anything else yields [].
    """
    if query is None:
        return []
    match = _CODE_RE.search(str(query))
    if not match:
        return []
    return match.group(1)


def search(venue, query, _get=None):
    """Search KRX codes/names (offline; see SEARCH CHOICE in module docs).

    6-digit code -> venue guess list; name substring -> curated KNOWN
    majors. Returns [{symbol, name}] (max 20). ``_get`` is accepted for
    signature symmetry and intentionally unused (no network search).
    """
    v = check_venue(venue if venue else '')
    q = '' if query is None else str(query).strip()
    if not q:
        return []
    if len(q) > 64:
        raise Exception('korea: search query too long (max 64 chars)')
    out = []
    code = match_code_pattern(q)
    if code:
        try:
            normalize_code(code)
        except Exception:
            code = None
    if code:
        targets = [v] if v else list(_SUPPORTED_VENUES)
        for target in targets:
            out.append({'symbol': code,
                        'name': '%s (%s guess)' % (code, target)})
    ql = q.lower()
    for known_code, name in KNOWN:
        if ql in known_code or ql in name.lower():
            if any(r['symbol'] == known_code for r in out):
                continue
            out.append({'symbol': known_code, 'name': name})
        if len(out) >= 20:
            break
    return out[:20]

"""Europe direct-exchange source for the Opentape companion.

Covers three keyless browser-hostile venues through the localhost companion
(stdlib ``urllib`` only; no secrets; GET-only public data):

  1. SIX Swiss Exchange (cleanest) — ``charts.json`` parallel arrays under
     ``valors[0].data`` (``Date,Time,Close,Open,Low,High,TotalVolume`` with
     ``netting=1440`` for daily). Instruments are keyed
     ``{ISIN}{ccy}{digit}`` (e.g. ``CH0237935652CHF4``); the query carries
     ``where=ValorId={ticker}``. Quotes are ~15-min delayed (see
     ``STREAM['note']``) — this module maps them to daily candles only.
   2. Nasdaq Nordic DataFeedProxy — RETIRED 2026 (nasdaqomxnordic.com now
      redirects to nasdaq.com; verified live). The venue entry is kept so
      pickers can name it, but candles()/search() raise directing to Yahoo
      suffixes .ST/.HE/.CO/.OL. Parser helpers were removed with it.
  3. Borsa Italiana ``grafici.`` API —
     ``/api/instruments/{isin}/history/period`` (+ ``.../intraday``,
     documented but unused: no intraday interval is advertised). Calls
     require an Imperva warmup: fetch the interactive-chart page, extract
     the anonymous JWT + cookies, then call the API. A blocked warmup
     degrades to an honest ``Exception`` (never a substitute market).

Bench NOT built (fragile, add only behind proven gaps): Euronext Nyx AJAX,
LSE API gateway, boerse-frankfurt (header-minted session), and the
onvista/ariva/finanzen scrapes. They are login/WAF/challenge-gated or
layout-fragile HTML scrapes — none is a stable keyless JSON pipe today.

Live-only honesty: every fetch raises ``Exception(detail)`` on failure and
never substitutes another market's bars. Empty histories raise
("history unavailable") instead of charting silently.
"""

import datetime as _dt
import json as _json
import re as _re
import time as _time
import urllib.parse as _parse
import urllib.request as _request
from urllib.error import HTTPError as _HTTPError
from urllib.error import URLError as _URLError

SOURCE = 'europe'
LABEL = 'Europe Directs'
INTERVALS = ['1d']
STREAM = {'mode': 'snapshot', 'cadence': 900,
          'note': 'EOD snapshot; SIX ~15-min delayed; '
                  'Nordic endpoint retired (use Yahoo Nordics); Borsa WAF-gated'}

_HTTP_TIMEOUT = 15
_DAY_MS = 86400000

_SYM_RE = _re.compile(r'^[A-Za-z0-9.\-=^:/]{1,64}$')
_ISIN_RE = _re.compile(r'^[A-Z]{2}[A-Z0-9]{9}[0-9]$')
_VALOR_RE = _re.compile(r'^\d{1,12}$')

_UAS = [
    ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
     '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'),
    ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
     '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'),
    ('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) '
     'Gecko/20100101 Firefox/128.0'),
]

_VENUES = [
    {'id': 'SIX', 'label': 'SIX Swiss Exchange (~15-min delayed)'},
    {'id': 'NORDIC', 'label': 'Nasdaq Nordic (endpoint retired — use Yahoo .ST/.HE/.CO/.OL)'},
    {'id': 'BORSA-IT', 'label': 'Borsa Italiana (WAF warmup)'},
]
_VENUE_IDS = frozenset(v['id'] for v in _VENUES)

# ---------------------------------------------------------------- endpoints ---

SIX_BASE = 'https://www.six-group.com/itf/fqs/delayed/charts.json'
SIX_COLUMNS = 'Date,Time,Close,Open,Low,High,TotalVolume'
SIX_NETTING_DAILY = 1440  # minutes per bar: daily aggregation
SIX_REF_URL = 'https://www.six-group.com/fqs/ref.csv'
_FULLVALOR_RE = _re.compile(r'^[A-Z]{2}[A-Z0-9]{10}[A-Z]{3}[0-9]$')

# Nasdaq Nordic DataFeedProxy retired in 2026 (host redirects to nasdaq.com
# marketing pages): no keyless direct pipe remains. Yahoo suffixes cover it.
_NORDIC_RETIRED = (
    'europe/nordic: DataFeedProxy endpoint retired '
    '(nasdaqomxnordic.com now redirects to nasdaq.com) — '
    'use Yahoo suffixes .ST/.HE/.CO/.OL for Nordics instead')

BORSA_PAGE_URL = 'https://grafici.borsaitaliana.it/'
BORSA_API_BASE = 'https://grafici.borsaitaliana.it/api'


# ---------------------------------------------------------------- venues ---

def venues():
    """Return venue descriptors (SIX / NORDIC / BORSA-IT)."""
    return [dict(v) for v in _VENUES]


# ---------------------------------------------------------------- validation ---

def _validate_interval(interval):
    if interval not in INTERVALS:
        raise Exception(
            'europe: unsupported interval %r (supported: %s)'
            % (interval, ', '.join(INTERVALS)))
    return interval


def _validate_venue(venue):
    up = (venue or '').strip().upper()
    if up not in _VENUE_IDS:
        raise Exception(
            'europe: unknown venue %r; expected one of: %s'
            % (venue, ', '.join(sorted(_VENUE_IDS))))
    return up


def _validate_symbol(symbol):
    s = (symbol or '').strip()
    if not s:
        raise Exception('europe: empty symbol')
    if not _SYM_RE.match(s):
        raise Exception(
            'europe: invalid symbol %r; use letters, digits, %r'
            % (s, '.-=/^:'))
    return s


def _clamp_limit(limit):
    try:
        n = int(limit)
    except (TypeError, ValueError):
        raise Exception('europe: invalid limit %r; expected 1..1000'
                        % (limit,))
    return max(1, min(1000, n))


def _pick_ua(key=None):
    if key is None:
        key = int(_time.time())
    return _UAS[key % len(_UAS)]


def _window_days(limit):
    """Over-fetch ~2x plus slack: upstream skips non-sessions, we trim."""
    return max(1, int(limit)) * 2 + 10


# ---------------------------------------------------------------- transport ---

def _get_json(url, headers=None, timeout=_HTTP_TIMEOUT):
    """GET a URL and decode its JSON body; WAF/rate errors map honestly."""
    req_headers = {'User-Agent': _pick_ua(), 'Accept': 'application/json'}
    if headers:
        req_headers.update(headers)
    req = _request.Request(url, headers=req_headers)
    try:
        with _request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8')
    except _HTTPError as exc:
        if exc.code == 429:
            raise Exception('europe: rate limited (429), retry shortly')
        if exc.code == 403:
            raise Exception(
                'europe: upstream blocked (403, WAF/challenge suspected) '
                'for %s' % url.split('?')[0])
        if exc.code == 404:
            raise Exception(
                'europe: upstream 404 for %s (unknown symbol?)'
                % url.split('?')[0])
        raise Exception('europe: upstream HTTP %s: %s'
                        % (exc.code, exc.reason))
    except _URLError as exc:
        raise Exception('europe: network error: %s' % exc.reason)
    except (TimeoutError, OSError) as exc:
        raise Exception('europe: network error: %s' % exc)
    try:
        return _json.loads(raw)
    except ValueError as exc:
        raise Exception('europe: parse error: invalid JSON (%s)' % exc)


def _warmup_fetch(url, timeout=_HTTP_TIMEOUT):
    """GET a warmup page; return (set-cookie headers, body text).

    HTTP errors are returned (not raised) so the caller can tell a WAF
    block apart from a network failure.
    """
    req = _request.Request(
        url, headers={'User-Agent': _pick_ua(),
                      'Accept': 'text/html,application/xhtml+xml'})
    try:
        with _request.urlopen(req, timeout=timeout) as resp:
            cookies = [v for k, v in resp.getheaders()
                       if k.lower() == 'set-cookie']
            return resp.status, cookies, resp.read().decode('utf-8', 'replace')
    except _HTTPError as exc:
        try:
            body = exc.read().decode('utf-8', 'replace')
        except (OSError, ValueError):
            body = ''
        cookies = []
        try:
            headers = exc.headers
            if headers:
                cookies = [v for k, v in headers.items()
                           if k.lower() == 'set-cookie']
        except (AttributeError, ValueError):
            pass
        return exc.code, cookies, body
    except _URLError as exc:
        raise Exception('europe: network error: %s' % exc.reason)
    except (TimeoutError, OSError) as exc:
        raise Exception('europe: network error: %s' % exc)


# ---------------------------------------------------------------- numbers/dates ---

def _num(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(',', '')
    if text in ('', '--', 'nan', 'NaN', 'None', 'null'):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _date_to_ms(value):
    """Parse Date+Time cell values to epoch ms (int).

    Date-only values are UTC midnight (daily bars ignore the Time leg).
    Accepts YYYYMMDD, YYYY-MM-DD, DD.MM.YYYY, epoch s/ms, /Date(ms)/.
    Eight-digit YYYYMMDD ints (SIX Date leg) parse as calendar dates —
    epoch seconds have ten digits in this era, so there is no ambiguity.
    """
    if value is None or isinstance(value, bool):
        raise ValueError('empty date')
    if isinstance(value, (int, float)):
        v = float(value)
        if v == int(v) and 19000101 <= int(v) <= 21001231:
            s = str(int(v))
            dt = _dt.datetime(int(s[0:4]), int(s[4:6]), int(s[6:8]),
                              tzinfo=_dt.timezone.utc)
            return int(dt.timestamp() * 1000)
        return int(v * 1000.0 if v < 1e11 else v)
    text = str(value).strip()
    if not text:
        raise ValueError('empty date')
    m = _re.match(r'^/Date\((\d+)([+-]\d{4})?\)/?$', text)
    if m:
        v = float(m.group(1))
        return int(v * 1000.0 if v < 1e11 else v)
    m = _re.match(r'^(\d{4})(\d{2})(\d{2})$', text)
    if m:
        dt = _dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                          tzinfo=_dt.timezone.utc)
        return int(dt.timestamp() * 1000)
    iso = text.replace('/', '-')
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d',
                '%d.%m.%Y', '%d-%m-%Y'):
        try:
            dt = _dt.datetime.strptime(iso, fmt)
            if fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M'):
                # Session-local stamp on a daily bar: keep the date part.
                dt = dt.replace(hour=0, minute=0, second=0)
            dt = dt.replace(tzinfo=_dt.timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError('unparseable date %r' % (value,))


def _norm_bars(bars):
    """Sort ascending by t; contract shape is checked by callers."""
    bars.sort(key=lambda b: b['t'])
    return bars


# ---------------------------------------------------------------- SIX ---

def six_chart_url(ticker, fromdate, todate=None):
    """Pure charts.json URL builder (daily netting, OHLCV columns).

    ``select=ValorId`` is mandatory (the API 400s without it) and ``todate``
    bounds the window; the ticker must be the full ValorId form
    (``CH…CHF4``, see six_resolve_valorid) or a bare numeric ValorId.
    """
    if todate is None:
        todate = _dt.date.today().strftime('%Y%m%d')
    q = _parse.urlencode({
        'netting': SIX_NETTING_DAILY,
        'columns': SIX_COLUMNS,
        'fromdate': fromdate,
        'todate': todate,
        'where': 'ValorId=%s' % ticker,
        'select': 'ValorId',
    })
    return '%s?%s' % (SIX_BASE, q)


def six_ref_url(field, value):
    """Pure ref.csv URL builder resolving tickers to full ValorIds."""
    q = _parse.urlencode({
        'select': 'ValorSymbol,ValorId,ISIN,TradingBaseCurrency,ValorNumber',
        'where': '%s=%s' % (field, value),
    })
    return '%s?%s' % (SIX_REF_URL, q)


def six_resolve_valorid(symbol, _fetch_text=None):
    """Resolve user input to the full ValorId charts.json requires.

    Full ``CH…CHF4`` form passes through verbatim (no network). ISINs,
    bare numeric ValorNumbers and ValorSymbols resolve via ref.csv — a bare
    number does NOT work directly against charts.json (empty series).
    Raises with reason otherwise.
    """
    s = (symbol or '').strip().upper().replace(' ', '')
    if not s:
        raise Exception('europe/six: empty symbol')
    if _FULLVALOR_RE.match(s):
        return s
    if _ISIN_RE.match(s):
        field, value = 'ISIN', s
    elif _VALOR_RE.match(s):
        field, value = 'ValorNumber', s
    elif _re.match(r'^[A-Z][A-Z0-9.\-]{0,11}$', s):
        field, value = 'ValorSymbol', s
    else:
        raise Exception(
            'europe/six: unresolvable symbol %r; use an ISIN '
            '(e.g. CH0012005267), ValorId or ValorSymbol' % symbol)
    fetch = _fetch_text or _fetch_ref_text
    try:
        text = fetch(six_ref_url(field, value))
    except Exception as exc:
        raise Exception('europe/six: ValorId lookup failed for %r: %s'
                        % (s, exc))
    header_idx = None
    for line in text.splitlines():
        cells = [c.strip().strip('"') for c in line.split(';')]
        if len(cells) < 2:
            continue
        if header_idx is None:
            lower = [c.lower() for c in cells]
            if 'valorid' in lower:
                header_idx = lower.index('valorid')
            continue
        # Only accept the row carrying the queried identifier (ISIN,
        # ValorNumber or ValorSymbol) — never another row's ValorId.
        if s not in [c.upper() for c in cells]:
            continue
        if header_idx < len(cells):
            cand = cells[header_idx].upper()
            if _FULLVALOR_RE.match(cand):
                return cand
    raise Exception(
        'europe/six: no ValorId mapping for %r '
        '(unknown/delisted on SIX?)' % s)


def _fetch_ref_text(url):
    """GET a ref.csv URL and return its text body."""
    req = _request.Request(
        url, headers={'User-Agent': _pick_ua(), 'Accept': 'text/csv'})
    try:
        with _request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return resp.read().decode('utf-8', 'replace')
    except _HTTPError as exc:
        raise Exception('europe/six: ref.csv HTTP %s' % exc.code)
    except (_URLError, TimeoutError, OSError) as exc:
        raise Exception('europe/six: ref.csv network error: %s' % exc)


def six_fromdate(limit, today=None):
    """Pure YYYYMMDD window start for ``limit`` daily bars."""
    today = today or _dt.date.today()
    start = today - _dt.timedelta(days=_window_days(limit))
    return start.strftime('%Y%m%d')


def _six_column(data, *names):
    """Case-insensitive column lookup over a parallel-array data dict."""
    if not isinstance(data, dict):
        return None
    lower = {str(k).lower(): v for k, v in data.items()}
    for name in names:
        if name.lower() in lower:
            vals = lower[name.lower()]
            if isinstance(vals, (list, tuple)):
                return list(vals)
    return None


def parse_six(payload):
    """Decode a SIX charts.json payload to ascending daily bars.

    Parallel arrays live under ``valors[0].data``. The ``Time`` leg is
    ignored: daily bars land on UTC midnight of the ``Date`` leg.
    Rows missing any of O/H/L/C are skipped; missing volume becomes 0.
    Returns [] when the payload carries no usable rows.
    """
    if not isinstance(payload, dict):
        raise Exception('europe/six: parse error: not a charts.json payload')
    valors = payload.get('valors')
    if not isinstance(valors, list) or not valors:
        raise Exception('europe/six: parse error: missing valors[] array')
    first = valors[0]
    if not isinstance(first, dict):
        raise Exception('europe/six: parse error: malformed valors[0]')
    data = first.get('data')
    if not isinstance(data, dict):
        raise Exception('europe/six: parse error: missing valors[0].data')
    dates = _six_column(data, 'Date')
    closes = _six_column(data, 'Close')
    opens = _six_column(data, 'Open')
    lows = _six_column(data, 'Low')
    highs = _six_column(data, 'High')
    vols = _six_column(data, 'TotalVolume', 'Volume')
    if dates is None or closes is None:
        raise Exception('europe/six: parse error: no Date/Close columns')
    n = max(len(dates), len(closes or []), len(opens or []),
            len(highs or []), len(lows or []), len(vols or []))

    def _at(cols, i):
        return cols[i] if cols is not None and i < len(cols) else None

    bars = []
    for i in range(n):
        o = _num(_at(opens, i))
        h = _num(_at(highs, i))
        lo = _num(_at(lows, i))
        c = _num(_at(closes, i))
        if o is None or h is None or lo is None or c is None:
            continue
        try:
            t = _date_to_ms(_at(dates, i))
        except (ValueError, TypeError, OverflowError):
            continue
        v = _num(_at(vols, i))
        bars.append({'t': t, 'o': o, 'h': h, 'l': lo, 'c': c,
                     'v': v if v is not None else 0.0})
    return _norm_bars(bars)


def _six_candles(ticker, limit, _fetcher=None, _resolve_text=None):
    resolved = six_resolve_valorid(ticker, _fetch_text=_resolve_text)
    url = six_chart_url(resolved, six_fromdate(limit))
    payload = _fetcher(url) if _fetcher else _get_json(url)
    bars = parse_six(payload)
    if not bars:
        raise Exception(
            'europe/six: history unavailable for %r '
            '(empty charts.json series — delisted/unknown ValorId?)'
            % ticker)
    return bars[-limit:]


def _six_search(query):
    """SIX has no keyless symbol-registry pipe: ISIN/ValorId direct entry."""
    q = (query or '').strip()
    if not q:
        raise Exception('europe/six: empty search query')
    up = q.upper().replace(' ', '')
    if _ISIN_RE.match(up) or _VALOR_RE.match(up):
        return [{'symbol': up,
                 'name': '%s (SIX direct ValorId/ISIN entry)' % up}]
    raise Exception(
        'europe/six: search needs an ISIN (e.g. CH0012005267) or ValorId '
        '(e.g. 1200526); no keyless SIX symbol registry is available')


# ------------------------------------------------- shared date/point helpers ---
def _iso_day(value):
    if value is None or isinstance(value, bool):
        raise ValueError('empty date')
    if isinstance(value, (int, float)):
        v = float(value)
        if v == int(v) and 19000101 <= int(v) <= 21001231:
            s = str(int(v))
            dt = _dt.datetime(int(s[0:4]), int(s[4:6]), int(s[6:8]),
                              tzinfo=_dt.timezone.utc)
            return int(dt.timestamp() * 1000)
        return int(v * 1000.0 if v < 1e11 else v)
    text = str(value).strip()
    if not text:
        raise ValueError('empty date')
    m = _re.match(r'^/Date\((\d+)([+-]\d{4})?\)/?$', text)
    if m:
        v = float(m.group(1))
        return int(v * 1000.0 if v < 1e11 else v)
    iso = text.replace('/', '-').replace('T', ' ')
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try:
            dt = _dt.datetime.strptime(iso.split('.')[0], fmt)
            if fmt == '%Y-%m-%d':
                dt = dt.replace(tzinfo=_dt.timezone.utc)
            else:
                dt = dt.replace(hour=0, minute=0, second=0,
                                tzinfo=_dt.timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    return _date_to_ms(text)


_POINT_DATE_KEYS = ('d', 'date', 't', 'time', 'timestamp', 'x')
_POINT_CLOSE_KEYS = ('cp', 'c', 'close', 'price', 'y', 'value')
_POINT_OPEN_KEYS = ('o', 'open')
_POINT_HIGH_KEYS = ('h', 'high')
_POINT_LOW_KEYS = ('l', 'low')
_POINT_VOL_KEYS = ('v', 'vol', 'volume', 'totalvolume')


def _point_get(point, keys):
    if not isinstance(point, dict):
        return None
    lower = {str(k).lower(): v for k, v in point.items()}
    for key in keys:
        if key in lower:
            return lower[key]
    return None



# ---------------------------------------------------------------- Borsa Italiana ---

def borsa_history_url(isin, start, end):
    """Pure grafici history/period URL builder (daily resolution)."""
    q = _parse.urlencode({'from': start, 'to': end, 'resolution': 'D'})
    return '%s/instruments/%s/history/period?%s' % (
        BORSA_API_BASE, _parse.quote(isin, safe=''), q)


def borsa_intraday_url(isin):
    """Pure grafici intraday URL builder (documented; no interval uses it)."""
    return '%s/instruments/%s/intraday' % (
        BORSA_API_BASE, _parse.quote(isin, safe=''))

_JWT_RE = _re.compile(
    r'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+')
_TOKEN_RE = _re.compile(
    r'"(?:access_?token|id_?token|jwt|anonymous_?token)"\s*:\s*"([^"]+)"',
    _re.IGNORECASE)
_WAF_MARKERS = ('incapsula', 'imperva', '_incap', 'visid_incap',
                'request unsuccessful', 'access denied', 'just a moment',
                'attention required')


def extract_borsa_warmup(page_text, set_cookie_headers):
    """Extract the anonymous JWT + cookies from a warmup page fetch.

    Returns ``{'jwt': str|None, 'cookies': {name: value},
    'waf_blocked': bool}``. Never raises: a blocked/empty warmup is data
    the caller turns into an honest error.
    """
    text = page_text or ''
    cookies = {}
    for header in set_cookie_headers or []:
        first = str(header).split(';', 1)[0]
        if '=' in first:
            name, _, value = first.partition('=')
            name, value = name.strip(), value.strip()
            if name:
                cookies[name] = value
    lowered = text.lower()
    waf_blocked = any(m in lowered for m in _WAF_MARKERS)
    jwt = None
    m = _JWT_RE.search(text)
    if m:
        jwt = m.group(0)
    else:
        m = _TOKEN_RE.search(text)
        if m:
            jwt = m.group(1)
    return {'jwt': jwt, 'cookies': cookies, 'waf_blocked': waf_blocked}


def _borsa_warmup(_warmup_fetcher=None):
    """Run the Imperva warmup; return auth headers or raise honestly."""
    if _warmup_fetcher is not None:
        status, cookie_headers, text = _warmup_fetcher(BORSA_PAGE_URL)
    else:
        status, cookie_headers, text = _warmup_fetch(BORSA_PAGE_URL)
    found = extract_borsa_warmup(text, cookie_headers)
    if found['waf_blocked'] or status == 403:
        raise Exception(
            'europe/borsa-it: WAF warmup blocked (HTTP %s, '
            'Imperva/Incapsula challenge); history unavailable — retry later'
            % status)
    if not found['jwt'] and not found['cookies']:
        raise Exception(
            'europe/borsa-it: warmup yielded no anonymous JWT or cookies '
            '(HTTP %s); history unavailable — retry later' % status)
    headers = {}
    if found['jwt']:
        headers['Authorization'] = 'Bearer %s' % found['jwt']
    if found['cookies']:
        headers['Cookie'] = '; '.join('%s=%s' % item
                                      for item in found['cookies'].items())
    return headers


def parse_borsa(payload):
    """Decode a grafici history/period payload to ascending daily bars.

    Accepts a bare list or a dict wrapping rows under history/data/bars/
    candles/series/items; row keys ``date|datetime|t|time|d``,
    ``open|high|low|close`` (single-letter + prefixed variants) and
    ``volume|volumes|totalVolume``. Rows missing OHLC are skipped;
    missing volume becomes 0. Returns [] on no usable rows.
    """
    if isinstance(payload, dict):
        rows = None
        for key in ('history', 'data', 'bars', 'candles', 'series',
                    'items', 'values'):
            for variant in (key, key.lower()):
                if variant in payload and isinstance(payload[variant], list):
                    rows = payload[variant]
                    break
            if rows is not None:
                break
        if rows is None:
            raise Exception('europe/borsa-it: parse error: not a grafici '
                            'history payload')
    elif isinstance(payload, list):
        rows = payload
    else:
        raise Exception('europe/borsa-it: parse error: not a grafici '
                        'history payload')
    bars = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        t_raw = _point_get(row, ('date', 'datetime', 't', 'time', 'd',
                                 'timestamp'))
        o = _num(_point_get(row, ('o', 'open', 'openprice')))
        h = _num(_point_get(row, ('h', 'high', 'highprice')))
        lo = _num(_point_get(row, ('l', 'low', 'lowprice')))
        c = _num(_point_get(row, ('c', 'close', 'closeprice',
                                  'last', 'price')))
        if o is None or h is None or lo is None or c is None:
            continue
        try:
            if isinstance(t_raw, (int, float)) or (
                    isinstance(t_raw, str) and
                    _re.match(r'^/Date\(|^ *[0-9]{9,13} *$', t_raw)):
                t = _iso_day(t_raw)
            else:
                t = _date_to_ms(t_raw)
        except (ValueError, TypeError, OverflowError):
            continue
        v = _num(_point_get(row, ('volume', 'volumes', 'totalvolume',
                                  'v', 'vol', 'turnover')))
        bars.append({'t': t, 'o': o, 'h': h, 'l': lo, 'c': c,
                     'v': v if v is not None else 0.0})
    return _norm_bars(bars)


def _borsa_candles(isin, limit, _fetcher=None, _warmup_fetcher=None):
    up = isin.upper().replace(' ', '')
    if not _ISIN_RE.match(up):
        raise Exception(
            'europe/borsa-it: expected an ISIN symbol (e.g. IT0000072618), '
            'got %r' % isin)
    today = _dt.date.today()
    start = today - _dt.timedelta(days=_window_days(limit))
    headers = _borsa_warmup(_warmup_fetcher=_warmup_fetcher)
    url = borsa_history_url(up, start.isoformat(), today.isoformat())
    if _fetcher is not None:
        payload = _fetcher(url, headers)
    else:
        payload = _get_json(url, headers=headers)
    bars = parse_borsa(payload)
    if not bars:
        raise Exception(
            'europe/borsa-it: history unavailable for %r '
            '(empty history/period series — delisted/unknown ISIN?)' % up)
    return bars[-limit:]


# ---------------------------------------------------------------- contract ---

def candles(venue, symbol, interval, limit=300, _fetcher=None,
            _warmup_fetcher=None, _resolve_text=None):
    """Fetch ascending [{t(ms),o,h,l,c,v}] for (venue, symbol, '1d').

    ``_fetcher`` / ``_warmup_fetcher`` are test seams (the companion
    server calls with the four public arguments only). Only ``1d`` is
    advertised: no venue has proven an intraday pipe here, so anything
    else raises naming the supported list.
    """
    _validate_interval(interval)
    venue_id = _validate_venue(venue)
    symbol = _validate_symbol(symbol)
    n = _clamp_limit(limit)
    if venue_id == 'SIX':
        return _six_candles(symbol, n, _fetcher=_fetcher,
                              _resolve_text=_resolve_text)
    if venue_id == 'NORDIC':
        raise Exception(_NORDIC_RETIRED)
    return _borsa_candles(symbol, n, _fetcher=_fetcher,
                          _warmup_fetcher=_warmup_fetcher)


def search(venue, query, _fetcher=None):
    """Symbol lookup per venue; returns [{symbol, name}]."""
    venue_id = _validate_venue(venue)
    if venue_id == 'SIX':
        return _six_search(query)
    if venue_id == 'NORDIC':
        raise Exception(_NORDIC_RETIRED)
    q = (query or '').strip()
    if not q:
        raise Exception('europe/borsa-it: empty search query')
    up = q.upper().replace(' ', '')
    if _ISIN_RE.match(up):
        return [{'symbol': up, 'name': '%s (Borsa Italiana direct ISIN)'
                % up}]
    raise Exception(
        'europe/borsa-it: search needs an ISIN (e.g. IT0000072618); '
        'no keyless Borsa symbol registry is available')


def quote(venue, symbol, _fetcher=None, _warmup_fetcher=None,
          _resolve_text=None):
    """Last close + prev close + change% from 2 daily bars (cheap)."""
    venue_id = _validate_venue(venue)
    symbol = _validate_symbol(symbol)
    bars = candles(venue_id, symbol, '1d', limit=5, _fetcher=_fetcher,
                   _warmup_fetcher=_warmup_fetcher,
                   _resolve_text=_resolve_text)
    if len(bars) < 2:
        raise Exception(
            'europe: not enough data for quote %s: need 2 daily bars, got %d'
            % (symbol, len(bars)))
    prev, last = bars[-2]['c'], bars[-1]['c']
    change = ((last - prev) / prev * 100.0) if prev else 0.0
    return {
        'symbol': symbol,
        'venue': venue_id,
        'price': last,
        'prev_close': prev,
        'change_pct': change,
        't': bars[-1]['t'],
    }

"""India (NSE / BSE / MCX / MF-NAV) companion source.

Stdlib only: urllib, json, csv, io, zipfile, datetime. No third-party
imports -- and in particular this module never imports ``nsepython``
(GPL); it talks to public HTTP endpoints only.

Venue routing (see ``candles``):
  NSE    -> NSE MCP history tools first (``get_stock_history`` /
           ``get_index_history``, 3-month pages chained via
           ``next_end_date``), with the official daily EOD archives
           (``ind_close_all_DDMMYYYY.csv`` + EQUITIES bhavcopy ZIP) as
           the T+1 fallback. Corporate-action adjustments are applied
           best-effort when ``get_corporate_actions`` answers.
  BSE    -> Official daily EOD archives (bhavcopy) looked up by scrip
           code or short name. DOCUMENTED CHOICE: BSE is *not* routed
           through the NSE MCP surface -- the MCP tools observed are
           NSE-only (``get_stock_history`` takes NSE symbols), so
           sending BSE scrips there would mislabel the market. BSE
           EOD archives are the honest direct route.
  MCX    -> ``GetDateWiseBhavCopy`` behind a cookie+XSRF session with
           403-tolerant retry (one cookie refresh, then degrade with a
           reason). A series is built day-by-day from the date-wise
           file using the nearest-expiry contract each day -- note the
           continuous-series limitation: rolls between expiries show
           as jumps, not as adjusted history. MCX failures degrade
           (raise with reason) and are never fatal to other venues.
           NCDEX raises 'unsupported market' (no keyless direct route).
  MF-NAV -> AMFI ``navAll.txt`` per scheme code, or ``mfapi.in``
           history (``/mf/<code>``). NAV lines become candles with
           o=h=l=c=NAV and v=0.

Only the ``1d`` interval is accepted; anything else raises with the
supported list. All rows are daily ``{t,o,h,l,c,v}`` ascending, ``t``
in integer ms since epoch (UTC midnight).
"""

import csv
import io
import json
import zipfile
from datetime import date, datetime, timedelta, timezone
from urllib import parse as _urlparse
from urllib import request as _urlrequest
from urllib.error import HTTPError, URLError

SOURCE = 'india'
LABEL = 'India (NSE/BSE/MCX)'
INTERVALS = ['1d']
STREAM = {'mode': 'snapshot', 'cadence': 300,
          'note': 'EOD T+1; no intraday on direct routes'}

_VENUES = (
    ('NSE', 'NSE equities & indices'),
    ('BSE', 'BSE equities (EOD archives)'),
    ('MCX', 'MCX commodity futures (date-wise bhavcopy)'),
    ('MF-NAV', 'Mutual-fund NAV lines (AMFI / mfapi.in)'),
)

_SUPPORTED_VENUES = [v[0] for v in _VENUES]


def venues():
    """Return [{'id', 'label'}] venue descriptors."""
    return [{'id': vid, 'label': vlabel} for vid, vlabel in _VENUES]


# ---------------------------------------------------------------------------
# Endpoint constants (override points for operators / tests).
# Archive URL patterns are best-effort; every fetch failure surfaces as an
# Exception carrying the reason, never as another market's bars.
# ---------------------------------------------------------------------------

NSE_MCP_URL = 'https://mcp.nseindia.com/mcp'
NSE_IND_CLOSE_URL = ('https://www.nseindia.com/content/historical/EQUITIES/'
                     '{YYYY}/{MON}/ind_close_all_{DDMMYYYY}.csv')
NSE_BHAVCOPY_URL = ('https://www.nseindia.com/content/historical/EQUITIES/'
                    '{YYYY}/{MON}/cm{DD}{MON}{YYYY}bhav.csv.zip')
BSE_BHAVCOPY_URL = 'https://www.bseindia.com/download/Equity/EQ{DDMMYY}_CSV.ZIP'
AMFI_NAV_URL = 'https://www.amfiindia.com/spages/NAVAll.txt'
MFAPI_HISTORY_URL = 'https://api.mfapi.in/mf/{code}'
MCX_HOME_URL = 'https://www.mcxindia.com/'
MCX_BHAVCOPY_URL = 'https://www.mcxindia.com/BackPage/GetDateWiseBhavCopy'

_MCP_TOOL_STOCK = 'get_stock_history'
_MCP_TOOL_INDEX = 'get_index_history'
_MCP_TOOL_ACTIONS = 'get_corporate_actions'
_MCP_TOOL_SEARCH = 'search_symbols'
_MCP_TOOL_HOLIDAYS = 'get_holiday_master'

_UA = {'User-Agent': 'opentape-companion/1.0 (+localhost)', 'Accept': '*/*'}
_HTTP_TIMEOUT = 12
_MCP_TIMEOUT = 15


# ---------------------------------------------------------------------------
# Small HTTP helpers (urllib only).
# ---------------------------------------------------------------------------

def _http_get(url, headers=None, timeout=_HTTP_TIMEOUT):
    req = _urlrequest.Request(url, headers=dict(_UA, **(headers or {})))
    try:
        with _urlrequest.urlopen(req, timeout=timeout) as resp:
            return resp.read(), dict(resp.headers.items())
    except HTTPError as exc:
        raise Exception('GET %s -> HTTP %s: %s' % (url, exc.code, exc.reason))
    except URLError as exc:
        raise Exception('GET %s failed: %s' % (url, exc.reason))


def _http_post(url, payload_bytes, headers=None, timeout=_HTTP_TIMEOUT):
    req = _urlrequest.Request(url, data=payload_bytes,
                              headers=dict(_UA, **(headers or {})))
    try:
        with _urlrequest.urlopen(req, timeout=timeout) as resp:
            return resp.read(), dict(resp.headers.items())
    except HTTPError as exc:
        raise Exception('POST %s -> HTTP %s: %s' % (url, exc.code, exc.reason))
    except URLError as exc:
        raise Exception('POST %s failed: %s' % (url, exc.reason))


def _lower_headers(headers):
    return {str(k).lower(): v for k, v in dict(headers or {}).items()}


# ---------------------------------------------------------------------------
# NSE MCP client (stdlib): 2-step session handshake + SSE parse.
#
#   1. POST <base> {"jsonrpc":"2.0","method":"initialize",...}
#      -> response header ``Mcp-Session-Id`` pins the session.
#   2. POST <base> with ``Mcp-Session-Id`` header for
#      ``tools/list`` and ``tools/call``.
# Responses may be plain JSON or Server-Sent Events with
# ``event: message`` / ``data: {...}`` frames.
# ---------------------------------------------------------------------------

def parse_sse(text):
    """Parse an SSE stream into [{'event', 'data'}]. Pure.

    Blank-line separated frames; ```` lines are comments and are
    skipped; multiple ``data:`` lines join with '\\n'.
    """
    frames = []
    event = 'message'
    data_lines = []
    has_fields = False

    def flush():
        if has_fields:
            frames.append({'event': event, 'data': '\n'.join(data_lines)})

    for raw in str(text).replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        line = raw.strip()
        if line == '':
            flush()
            event, data_lines, has_fields = 'message', [], False
            continue
        if line.startswith(':'):
            continue
        if ':' in line:
            field, _, value = line.partition(':')
            field = field.strip().lower()
            value = value.lstrip(' ')
            has_fields = True
            if field == 'event':
                event = value or 'message'
            elif field == 'data':
                data_lines.append(value)
            # other fields (id:, retry:) are irrelevant here
        # continuation lines without ':' are ignored
    flush()
    return frames


def sse_jsonrpc_results(text):
    """Extract JSON-RPC ``result`` payloads from an SSE stream. Pure.

    Raises Exception on a JSON-RPC ``error`` frame or on unparseable
    ``data:`` JSON.
    """
    results = []
    for frame in parse_sse(text):
        if frame['event'].lower() not in ('message', ''):
            continue
        try:
            msg = json.loads(frame['data'])
        except Exception as exc:
            raise Exception('NSE MCP: unparseable SSE data frame: %s' % exc)
        if isinstance(msg, dict) and 'error' in msg and msg['error'] is not None:
            err = msg['error']
            detail = err.get('message', err) if isinstance(err, dict) else err
            raise Exception('NSE MCP tools/call error: %s' % detail)
        if isinstance(msg, dict) and 'result' in msg:
            results.append(msg['result'])
    return results


def unwrap_mcp_result(result):
    """Unwrap the MCP ``content`` envelope to a plain value. Pure.

    ``tools/call`` results arrive as ``{'content': [{'type': 'text',
    'text': '<json>'}]}``; when the text parses as JSON it is returned
    parsed, otherwise the raw text (or the result itself) is returned.
    """
    if isinstance(result, dict) and isinstance(result.get('content'), list):
        texts = [c.get('text', '') for c in result['content']
                 if isinstance(c, dict) and 'text' in c]
        if len(texts) == 1:
            try:
                return json.loads(texts[0])
            except Exception:
                return texts[0]
        if texts:
            return texts
    return result


def decode_mcp_response(body_bytes):
    """Decode a tools/call (or initialize) response body. Pure.

    Handles both plain-JSON and SSE bodies; returns the ``result`` value
    (unwrapped). Raises Exception with the reason on any failure.
    """
    try:
        text = body_bytes.decode('utf-8', errors='replace')
    except Exception:
        text = str(body_bytes)
    stripped = text.lstrip()
    if stripped.startswith('{') or stripped.startswith('['):
        try:
            msg = json.loads(text)
        except Exception as exc:
            raise Exception('NSE MCP: unparseable JSON body: %s' % exc)
        if isinstance(msg, dict) and msg.get('error') is not None and 'error' in msg:
            err = msg['error']
            detail = err.get('message', err) if isinstance(err, dict) else err
            raise Exception('NSE MCP error: %s' % detail)
        payload = msg.get('result', msg) if isinstance(msg, dict) else msg
        return unwrap_mcp_result(payload)
    results = sse_jsonrpc_results(text)
    if not results:
        raise Exception('NSE MCP: empty SSE response (no result frames)')
    if len(results) > 1:
        return [unwrap_mcp_result(r) for r in results]
    return unwrap_mcp_result(results[0])


def mcp_initialize(base_url=NSE_MCP_URL, timeout=_MCP_TIMEOUT):
    """Run the MCP 2-step handshake; return the session id.

    POSTs ``initialize`` and reads the ``Mcp-Session-Id`` response
    header. Raises with reason when the header is absent.
    """
    payload = json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
        'params': {'protocolVersion': '2024-11-05', 'capabilities': {},
                   'clientInfo': {'name': 'opentape-companion',
                                  'version': '1.0'}},
    }).encode('utf-8')
    body, headers = _http_post(
        base_url, payload,
        headers={'Content-Type': 'application/json',
                 'Accept': 'application/json, text/event-stream'},
        timeout=timeout)
    session = _lower_headers(headers).get('mcp-session-id')
    if not session:
        raise Exception('NSE MCP initialize: missing Mcp-Session-Id '
                        'response header')
    # Best-effort initialized notification; never fatal.
    try:
        _http_post(base_url, json.dumps(
            {'jsonrpc': '2.0', 'method': 'notifications/initialized',
             'params': {}}).encode('utf-8'),
            headers={'Content-Type': 'application/json',
                     'Mcp-Session-Id': session},
            timeout=timeout)
    except Exception:
        pass
    return session


def mcp_tool_call(base_url, session_id, tool, arguments, timeout=_MCP_TIMEOUT):
    """Call one MCP tool inside ``session_id``; return the result value."""
    payload = json.dumps({
        'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
        'params': {'name': tool, 'arguments': dict(arguments or {})},
    }).encode('utf-8')
    body, _headers = _http_post(
        base_url, payload,
        headers={'Content-Type': 'application/json',
                 'Accept': 'application/json, text/event-stream',
                 'Mcp-Session-Id': session_id},
        timeout=timeout)
    return decode_mcp_response(body)


class NseMcp(object):
    """Tiny stateful NSE MCP session (lazy handshake)."""

    def __init__(self, base_url=NSE_MCP_URL, timeout=_MCP_TIMEOUT):
        self.base_url = base_url
        self.timeout = timeout
        self._session = None

    def call(self, tool, arguments):
        if self._session is None:
            self._session = mcp_initialize(self.base_url, self.timeout)
        return mcp_tool_call(self.base_url, self._session, tool, arguments,
                             self.timeout)


# ---------------------------------------------------------------------------
# Dates / numbers (pure).
# ---------------------------------------------------------------------------

_DATE_FMTS = ('%d-%b-%Y', '%d-%b-%y', '%d-%B-%Y', '%Y-%m-%d', '%d-%m-%Y',
              '%d/%m/%Y', '%Y/%m/%d', '%d%b%Y', '%d%b%y', '%d-%b-%y',
              '%Y%m%d', '%d%m%Y')


def date_to_ms(value):
    """Parse an NSE/AMFI/MCX date (or epoch) to UTC-midnight ms int. Pure."""
    if isinstance(value, bool):
        raise Exception('unparseable date: %r' % (value,))
    if isinstance(value, (int, float)):
        num = float(value)
        if num > 1e12:
            return int(num)
        if num > 1e9:
            return int(num * 1000)
        raise Exception('unparseable date: %r' % (value,))
    text = str(value).strip()
    if not text:
        raise Exception('unparseable date: %r' % (value,))
    if 'T' in text:
        # ISO 'YYYY-MM-DDTHH:MM:SS' only: a bare 'T' also occurs inside
        # month names (OCT, SEPT), so require a time-like tail.
        _head, _, _tail = text.partition('T')
        if _tail[:2].isdigit() and ':' in _tail[:6]:
            text = _head.strip()
    text = ' '.join(text.split())
    for fmt in _DATE_FMTS:
        try:
            dt = datetime.strptime(text.upper() if '%b' in fmt.lower()
                                   or '%B' in fmt else text, fmt)
            return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)
        except Exception:
            continue
    raise Exception('unparseable date: %r' % (value,))


def _fnum(value, default=0.0):
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(',', '')
    if text in ('', '-', '--', 'null', 'None', 'NA', '#N/A'):
        return default
    try:
        return float(text)
    except Exception:
        return default


def _utc_today():
    return datetime.now(timezone.utc).date()


# ---------------------------------------------------------------------------
# History rows: normalize / merge / chain (pure core + thin live fetchers).
# ---------------------------------------------------------------------------

def normalize_history_row(row):
    """Normalize one history row (several field spellings) to a candle. Pure.

    Returns ``{'t','o','h','l','c','v'}`` with ``t`` in ms.
    """
    if not isinstance(row, dict):
        raise Exception('history row must be an object, got %r' % (row,))
    day = (row.get('date') or row.get('tradingDate') or row.get('TIMESTAMP')
           or row.get('timestamp') or row.get('mktDate') or row.get('MKTDATE'))
    if day is None:
        raise Exception('history row has no date field: %r' % (row,))
    get = row.get

    def pick(*names, **kw):
        for name in names:
            if get(name) is not None:
                return get(name)
        return kw.get('default')

    o = _fnum(pick('open', 'OPEN', 'Open'))
    h = _fnum(pick('high', 'HIGH', 'High'))
    low = _fnum(pick('low', 'LOW', 'Low'))
    c = _fnum(pick('close', 'CLOSE', 'Close', 'last', 'LAST',
                   'settlePrice', 'SETTLE_PR'))
    v = _fnum(pick('volume', 'VOLUME', 'TOTTRDQTY', 'TotalTradedQuantity',
                   'VOL', 'Volume'), 0.0)
    return {'t': date_to_ms(day), 'o': o, 'h': h, 'l': low, 'c': c, 'v': v}


def merge_history_pages(pages):
    """Merge candle pages into one ascending, timestamp-deduped list. Pure.

    On duplicate ``t`` the later page wins (later pages are the fresher
    overlap in the next_end_date chaining).
    """
    by_t = {}
    for page in pages or []:
        for candle in page or []:
            by_t[candle['t']] = dict(candle)
    return [by_t[t] for t in sorted(by_t)]


def _history_rows(result):
    if isinstance(result, dict):
        for key in ('history', 'data', 'rows', 'records'):
            if isinstance(result.get(key), list):
                return result[key]
        return []
    if isinstance(result, list):
        return result
    return []


def _next_end_date(result):
    if isinstance(result, dict):
        return (result.get('next_end_date') or result.get('nextEndDate')
                or result.get('nextEnddate') or result.get('next_page_end'))
    return None


def clamp_months(months):
    """Clamp the MCP ``months`` argument to the 1..3 window the tool takes."""
    try:
        months = int(months)
    except Exception:
        months = 3
    return max(1, min(3, months))


def fetch_stock_history(symbol, end_date=None, months=3, _client=None):
    """NSE stock history, chaining 3-month pages via next_end_date."""
    months = clamp_months(months)
    client = _client if _client is not None else NseMcp()
    pages, end, guard = [], end_date, 0
    while True:
        args = {'symbol': symbol, 'months': months}
        if end:
            args['endDate'] = end
        try:
            result = client.call(_MCP_TOOL_STOCK, args)
        except Exception as exc:
            raise Exception('NSE get_stock_history(%s) failed: %s'
                            % (symbol, exc))
        rows = _history_rows(result)
        pages.append([normalize_history_row(r) for r in rows])
        end = _next_end_date(result)
        guard += 1
        if not end or guard >= 8:
            break
    merged = merge_history_pages(pages)
    if not merged:
        raise Exception('NSE get_stock_history(%s): no rows returned' % symbol)
    return merged


def fetch_index_history(name, end_date=None, months=3, _client=None):
    """NSE index history (same chaining contract as stock history)."""
    months = clamp_months(months)
    client = _client if _client is not None else NseMcp()
    pages, end, guard = [], end_date, 0
    while True:
        args = {'index': name, 'months': months}
        if end:
            args['endDate'] = end
        try:
            result = client.call(_MCP_TOOL_INDEX, args)
        except Exception as exc:
            raise Exception('NSE get_index_history(%s) failed: %s'
                            % (name, exc))
        rows = _history_rows(result)
        pages.append([normalize_history_row(r) for r in rows])
        end = _next_end_date(result)
        guard += 1
        if not end or guard >= 8:
            break
    merged = merge_history_pages(pages)
    if not merged:
        raise Exception('NSE get_index_history(%s): no rows returned' % name)
    return merged


# ---------------------------------------------------------------------------
# Corporate actions -> adjustment factors (pure) + live fetcher.
# ---------------------------------------------------------------------------

def parse_corporate_actions(payload):
    """Normalize a get_corporate_actions payload to action dicts. Pure.

    Returns [{'ex_date': ms, 'type': 'SPLIT'|'BONUS'|'DIVIDEND'|...,
    'factor': float, 'raw': ...}]. ``factor`` multiplies pre-ex-date
    prices (a 2:1 split -> 0.5). Dividends keep factor 1.0 (cash, no
    price adjustment) and are retained for display only.
    """
    if isinstance(payload, dict):
        for key in ('actions', 'corporateActions', 'data', 'rows'):
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
    if not isinstance(payload, list):
        return []
    out = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        atype = str(item.get('type', item.get('actionType',
                    item.get('ACTION', '')))).upper().strip()
        ex = (item.get('ex_date') or item.get('exDate')
              or item.get('EX_DATE') or item.get('date'))
        try:
            ex_ms = date_to_ms(ex)
        except Exception:
            continue
        factor = _action_factor(item, atype)
        out.append({'ex_date': ex_ms, 'type': atype or 'UNKNOWN',
                    'factor': factor, 'raw': item})
    return out


def _action_factor(item, atype):
    for key in ('factor', 'adjustmentFactor', 'FACTOR'):
        if item.get(key) is not None:
            try:
                return float(item[key])
            except Exception:
                pass
    ratio = (item.get('ratio') or item.get('RATIO') or item.get('splitRatio')
             or item.get('SPLIT_RATIO'))
    if ratio is not None and ('SPLIT' in atype or 'BONUS' in atype):
        old, new = _parse_ratio(ratio)
        if old and new:
            # '2:1' split -> pre-ex prices halve: factor = new/old.
            return new / old
    for key in ('oldQty', 'OLD', 'fromQty'):
        for key2 in ('newQty', 'NEW', 'toQty'):
            try:
                old = float(item.get(key, 0)) if item.get(key) else None
                new = float(item.get(key2, 0)) if item.get(key2) else None
            except Exception:
                old, new = None, None
            if old and new:
                return new / old
    return 1.0


def _parse_ratio(ratio):
    """Parse '2:1', '2/1', '2-for-1', [2, 1] -> (2.0, 1.0). Pure."""
    if isinstance(ratio, (list, tuple)) and len(ratio) == 2:
        try:
            return float(ratio[0]), float(ratio[1])
        except Exception:
            return None, None
    text = str(ratio).strip().replace('for', ':').replace('/', ':')
    if ':' not in text:
        return None, None
    left, _, right = text.partition(':')
    try:
        return float(left.strip()), float(right.strip())
    except Exception:
        return None, None


def compute_adjustment_factors(actions):
    """Sorted [(ex_ms, factor)] for price-affecting actions. Pure."""
    factors = [(a['ex_date'], a['factor']) for a in actions or []
               if a.get('factor') not in (None, 1.0)]
    try:
        return sorted(factors, key=lambda f: f[0])
    except Exception:
        return factors


def apply_adjustments(candles, actions):
    """Apply split/bonus factors to pre-ex-date candles. Pure.

    ``actions`` may be action dicts or ``(ex_ms, factor)`` pairs; each
    candle's o/h/l/c is multiplied by the product of factors whose
    ex-date is after the candle's time.
    """
    if isinstance(actions, list) and actions and not isinstance(actions[0], dict):
        factors = list(actions)
    else:
        factors = compute_adjustment_factors(actions)
    if not factors:
        return [dict(c) for c in candles or []]
    out = []
    for candle in candles or []:
        mult = 1.0
        for ex_ms, factor in factors:
            if ex_ms > candle['t']:
                mult *= factor
        row = dict(candle)
        for key in ('o', 'h', 'l', 'c'):
            row[key] = row[key] * mult
        out.append(row)
    return out


def fetch_corporate_actions(symbol, _client=None):
    """Fetch + normalize corporate actions (best-effort; [] on failure)."""
    try:
        client = _client if _client is not None else NseMcp()
        result = client.call(_MCP_TOOL_ACTIONS, {'symbol': symbol})
        return parse_corporate_actions(result)
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Holiday master (live fetcher + pure parser).
# ---------------------------------------------------------------------------

def parse_holiday_master(payload):
    """Normalize a holiday-master payload to sorted date-ms list. Pure."""
    if isinstance(payload, dict):
        for key in ('holidays', 'holidayMaster', 'data', 'rows', 'tradingHolidays'):
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
    if not isinstance(payload, list):
        return []
    out = []
    for item in payload:
        if isinstance(item, dict):
            day = (item.get('date') or item.get('holidayDate')
                   or item.get('tradingDate') or item.get('HOLIDAY_DATE'))
        else:
            day = item
        try:
            out.append(date_to_ms(day))
        except Exception:
            continue
    return sorted(set(out))


def fetch_holidays(_client=None):
    """Fetch the NSE holiday master (raises with reason on failure)."""
    client = _client if _client is not None else NseMcp()
    try:
        result = client.call(_MCP_TOOL_HOLIDAYS, {})
    except Exception as exc:
        raise Exception('NSE holiday-master fetch failed: %s' % exc)
    return parse_holiday_master(result)


# ---------------------------------------------------------------------------
# EOD archives: ind_close_all CSV + EQUITIES bhavcopy ZIP (pure parsers).
# ---------------------------------------------------------------------------

def _find_col(header, *names):
    norm = [str(h).strip().upper().replace(' ', '').replace('_', '')
            for h in header]
    for name in names:
        key = str(name).upper().replace(' ', '').replace('_', '')
        if key in norm:
            return norm.index(key)
    return None


def parse_eod_csv(text):
    """Parse an NSE/BSE daily EOD CSV into {KEY: row-dict}. Pure.

    Handles ``ind_close_all`` and both NSE/BSE bhavcopy header spellings.
    Keys are upper-cased SYMBOL (NSE) or SC_CODE (BSE); rows carry
    ``symbol``/``name``/``o``/``h``/``l``/``c``/``v``/``series``/``date``.
    On duplicate keys the SERIES='EQ' row wins.
    """
    content = str(text or '')
    if not content.strip():
        raise Exception('empty EOD CSV')
    reader = csv.reader(io.StringIO(content))
    header = None
    for row in reader:
        if row and any((c or '').strip() for c in row):
            header = row
            break
    if not header:
        raise Exception('EOD CSV has no header row')
    i_sym = _find_col(header, 'SYMBOL', 'SC_CODE', 'ScripCode', 'SCCODE')
    i_name = _find_col(header, 'SC_NAME', 'ScripName', 'COMPANY', 'NAME')
    i_series = _find_col(header, 'SERIES', 'SC_GROUP')
    i_o = _find_col(header, 'OPEN')
    i_h = _find_col(header, 'HIGH')
    i_lo = _find_col(header, 'LOW')
    i_c = _find_col(header, 'CLOSE')
    i_v = _find_col(header, 'TOTTRDQTY', 'TOTALTRDQTY', 'TTL_TRD_QNTY',
                    'NO_OF_SHRS', 'NOOFSHRS', 'VOLUME', 'VOL', 'TOTVOL',
                    'SHARES', 'QTY')
    i_date = _find_col(header, 'TIMESTAMP', 'TRADE_DATE', 'TRADEDATE',
                       'DATE', 'MKTDATE', 'TRD_DATE')
    if i_sym is None or i_c is None:
        raise Exception('EOD CSV missing SYMBOL/CLOSE columns: %s'
                        % (','.join(header)))
    out = {}

    def cell(row, idx):
        return row[idx].strip() if idx is not None and idx < len(row) else ''

    for row in reader:
        if not row or not any((c or '').strip() for c in row):
            continue
        key = cell(row, i_sym).upper()
        if not key:
            continue
        series = cell(row, i_series).upper()
        entry = {'symbol': key,
                 'name': cell(row, i_name) or key,
                 'o': _fnum(cell(row, i_o)),
                 'h': _fnum(cell(row, i_h)),
                 'l': _fnum(cell(row, i_lo)),
                 'c': _fnum(cell(row, i_c)),
                 'v': _fnum(cell(row, i_v), 0.0),
                 'series': series,
                 'date': cell(row, i_date)}
        prev = out.get(key)
        if prev is None or (prev.get('series') != 'EQ' and series == 'EQ'):
            out[key] = entry
    if not out:
        raise Exception('EOD CSV has no data rows')
    return out


def parse_ind_close_all(text):
    """Parse an ``ind_close_all_DDMMYYYY.csv`` file. Pure (see parse_eod_csv)."""
    return parse_eod_csv(text)


def parse_equity_bhavcopy(text):
    """Parse an EQUITIES bhavcopy CSV. Pure (see parse_eod_csv)."""
    return parse_eod_csv(text)


def parse_bhavcopy_zip(data):
    """Open a bhavcopy ZIP (bytes) and parse the first CSV inside. Pure."""
    if not data:
        raise Exception('empty bhavcopy ZIP')
    try:
        buf = io.BytesIO(bytes(data))
        with zipfile.ZipFile(buf) as zf:
            names = [n for n in zf.namelist()
                     if n.lower().endswith('.csv') and not n.endswith('/')]
            if not names:
                raise Exception('ZIP has no .csv member: %s' % zf.namelist())
            with zf.open(names[0]) as fh:
                text = fh.read().decode('utf-8', errors='replace')
    except zipfile.BadZipFile as exc:
        raise Exception('invalid bhavcopy ZIP: %s' % exc)
    return parse_eod_csv(text)


def _nse_archive_urls(day):
    yyyy = '%04d' % day.year
    mon = day.strftime('%b').upper()
    dd = '%02d' % day.day
    ddmmyyyy = '%s%s%s' % (dd, '%02d' % day.month, yyyy)
    return (NSE_IND_CLOSE_URL.format(YYYY=yyyy, MON=mon, DDMMYYYY=ddmmyyyy),
            NSE_BHAVCOPY_URL.format(YYYY=yyyy, MON=mon, DD=dd))


def _bse_archive_url(day):
    return BSE_BHAVCOPY_URL.format(
        DDMMYY='%02d%02d%02d' % (day.day, day.month, day.year % 100))


def _row_candle(day, row):
    return {'t': int(datetime(day.year, day.month, day.day,
                             tzinfo=timezone.utc).timestamp() * 1000),
            'o': row['o'], 'h': row['h'], 'l': row['l'],
            'c': row['c'], 'v': row['v']}


def fetch_nse_archive_day(symbol, day):
    """Fetch one NSE EOD row for ``symbol`` on ``day`` (ind_close_all, then
    bhavcopy ZIP). Returns the row dict or None when the symbol is absent;
    raises with reason when both files are unreachable."""
    sym = symbol.upper()
    ind_url, bhav_url = _nse_archive_urls(day)
    errors = []
    try:
        body, _ = _http_get(ind_url)
        table = parse_ind_close_all(body.decode('utf-8', errors='replace'))
        if sym in table:
            return table[sym]
        return None
    except Exception as exc:
        errors.append(str(exc))
    try:
        body, _ = _http_get(bhav_url)
        table = parse_bhavcopy_zip(body)
        return table.get(sym)
    except Exception as exc:
        errors.append(str(exc))
    raise Exception('NSE archives %s unreachable: %s' % (day.isoformat(), errors))


def fetch_bse_archive_day(symbol, day):
    """Fetch one BSE EOD row for a scrip code or short name on ``day``."""
    key = symbol.upper()
    url = _bse_archive_url(day)
    body, _ = _http_get(url)
    table = parse_bhavcopy_zip(body)
    if key in table:
        return table[key]
    for row in table.values():
        if row.get('name', '').upper() == key:
            return row
    return None


def build_series_from_daily(fetch_day, limit, start=None):
    """Walk back trading days via ``fetch_day(date)->row|None``. Pure logic.

    Weekends are skipped; missing-symbol days are skipped silently. Raises
    with the last upstream reason when nothing is found at all.
    """
    limit = max(1, min(1000, int(limit or 300)))
    out, errors = [], []
    day = start if start is not None else _utc_today()
    guard, max_days = 0, limit * 3 + 20
    while len(out) < limit and guard < max_days:
        if day.weekday() < 5:
            try:
                row = fetch_day(day)
            except Exception as exc:
                errors.append('%s: %s' % (day.isoformat(), exc))
                row = None
            if row is not None:
                out.append(_row_candle(day, row))
        day -= timedelta(days=1)
        guard += 1
    if not out:
        reason = errors[-1] if errors else 'symbol absent on recent trading days'
        raise Exception('daily-archive series: no data (%s)' % reason)
    out.sort(key=lambda c: c['t'])
    return out[-limit:]


# ---------------------------------------------------------------------------
# AMFI NAV + mfapi.in (pure parsers + thin live fetchers).
# ---------------------------------------------------------------------------

def parse_nav_all(text, code=None):
    """Parse AMFI ``navAll.txt`` into {code: {'name', 'points'}}. Pure.

    ``points`` are ``[(date_str, nav)]`` in file order (oldest first in
    practice). When ``code`` is given, only that scheme's points list is
    returned (raises when absent).
    """
    content = str(text or '')
    if not content.strip():
        raise Exception('empty NAVAll body')
    funds = {}
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.lower().startswith('scheme code'):
            continue
        parts = [p.strip() for p in line.split(';')]
        if len(parts) < 5:
            continue
        scode = parts[0].strip()
        if not scode or not scode[0].isdigit():
            continue
        if len(parts) >= 6:
            name, nav_txt, day_txt = parts[3], parts[4], parts[5]
        else:
            name, nav_txt, day_txt = parts[2], parts[3], parts[4]
        try:
            nav = float(nav_txt.replace(',', ''))
        except Exception:
            continue
        fund = funds.setdefault(scode, {'name': name, 'points': []})
        fund['points'].append((day_txt, nav))
    if code is not None:
        key = str(code).strip()
        if key not in funds:
            raise Exception('AMFI NAVAll: scheme code %s not found' % key)
        return funds[key]['points']
    return funds


def parse_mfapi_history(payload):
    """Parse an mfapi.in ``/mf/<code>`` payload to NAV candles. Pure.

    Each ``{'date': 'DD-MM-YYYY', 'nav': '...'}`` point becomes a candle
    with o=h=l=c=NAV and v=0, ascending by date.
    """
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception as exc:
            raise Exception('mfapi.in: unparseable body: %s' % exc)
    if not isinstance(payload, dict):
        raise Exception('mfapi.in: unexpected payload %r' % (payload,))
    status = str(payload.get('status', 'SUCCESS')).upper()
    if status != 'SUCCESS':
        raise Exception('mfapi.in: status %s' % status)
    data = payload.get('data')
    if not isinstance(data, list) or not data:
        raise Exception('mfapi.in: no NAV history in payload')
    candles = []
    for point in data:
        if not isinstance(point, dict):
            continue
        try:
            t = date_to_ms(point.get('date', ''))
            nav = float(str(point.get('nav', '')).replace(',', ''))
        except Exception:
            continue
        candles.append({'t': t, 'o': nav, 'h': nav, 'l': nav, 'c': nav,
                        'v': 0.0})
    if not candles:
        raise Exception('mfapi.in: no parseable NAV points')
    candles.sort(key=lambda c: c['t'])
    merged = {}
    for c in candles:
        merged[c['t']] = c
    return [merged[t] for t in sorted(merged)]


def nav_points_to_candles(points, limit=300):
    """Turn ``[(date_str, nav)]`` into ascending NAV candles. Pure."""
    candles = []
    for day_txt, nav in points or []:
        try:
            t = date_to_ms(day_txt)
            nav_f = float(nav)
        except Exception:
            continue
        candles.append({'t': t, 'o': nav_f, 'h': nav_f, 'l': nav_f,
                        'c': nav_f, 'v': 0.0})
    candles.sort(key=lambda c: c['t'])
    merged = {}
    for c in candles:
        merged[c['t']] = c
    ordered = [merged[t] for t in sorted(merged)]
    limit = max(1, min(1000, int(limit or 300)))
    return ordered[-limit:]


def fetch_nav_series(code, limit=300):
    """NAV daily series for an AMFI scheme code (mfapi.in, AMFI fallback)."""
    key = str(code).strip()
    if not key or not key[0].isdigit():
        raise Exception("MF-NAV symbol must be an AMFI scheme code "
                        "(digits, e.g. '119062'); use search to find one")
    errors = []
    try:
        body, _ = _http_get(MFAPI_HISTORY_URL.format(code=_urlparse.quote(key)))
        payload = json.loads(body.decode('utf-8'))
        return parse_mfapi_history(payload)[-limit:]
    except Exception as exc:
        errors.append('mfapi.in: %s' % exc)
    try:
        body, _ = _http_get(AMFI_NAV_URL)
        return nav_points_to_candles(parse_nav_all(body.decode('utf-8'), key),
                                     limit)
    except Exception as exc:
        errors.append('AMFI navAll.txt: %s' % exc)
    raise Exception('MF-NAV %s: no data (%s)' % (key, '; '.join(errors)))


# ---------------------------------------------------------------------------
# MCX date-wise bhavcopy (cookie+XSRF session, 403-tolerant) + pure parser.
# ---------------------------------------------------------------------------

def parse_mcx_bhavcopy(text):
    """Parse an MCX date-wise bhavcopy CSV into row dicts. Pure.

    Returns [{'symbol','expiry','expiry_ms','o','h','l','c','v','oi',
    'date'}]. Volume is in lots (contract size varies by symbol).
    """
    content = str(text or '')
    if not content.strip():
        raise Exception('empty MCX bhavcopy')
    reader = csv.reader(io.StringIO(content))
    header = None
    for row in reader:
        if row and any((c or '').strip() for c in row):
            header = row
            break
    if not header:
        raise Exception('MCX bhavcopy has no header row')
    i_sym = _find_col(header, 'SYMBOL', 'Symbol', 'COMMODITY', 'ScripCode')
    i_exp = _find_col(header, 'EXPIRY', 'Expiry', 'EXPIRYDATE', 'Maturity')
    i_o = _find_col(header, 'OPEN', 'OpenPrice')
    i_h = _find_col(header, 'HIGH', 'HighPrice')
    i_lo = _find_col(header, 'LOW', 'LowPrice')
    i_c = _find_col(header, 'CLOSE', 'SETTLE', 'SETTLEPRICE',
                    'SETTLEMENTPRICE', 'CLOSEPRICE')
    i_v = _find_col(header, 'VOLUME', 'VOL', 'VOLUMEINLOTS', 'TradedVolume',
                    'QTY')
    i_oi = _find_col(header, 'OI', 'OPENINTEREST', 'OPENINT', 'OpenInterest')
    i_date = _find_col(header, 'DATE', 'TRADEDATE', 'TRADE_DATE', 'TIMESTAMP')
    if i_sym is None or i_c is None:
        raise Exception('MCX bhavcopy missing SYMBOL/CLOSE columns: %s'
                        % (','.join(header)))
    out = []

    def cell(row, idx):
        return row[idx].strip() if idx is not None and idx < len(row) else ''

    for row in reader:
        if not row or not any((c or '').strip() for c in row):
            continue
        symbol = cell(row, i_sym).upper()
        if not symbol:
            continue
        expiry_txt = cell(row, i_exp)
        try:
            expiry_ms = date_to_ms(expiry_txt) if expiry_txt else 0
        except Exception:
            expiry_ms = 0
        out.append({'symbol': symbol, 'expiry': expiry_txt,
                    'expiry_ms': expiry_ms,
                    'o': _fnum(cell(row, i_o)), 'h': _fnum(cell(row, i_h)),
                    'l': _fnum(cell(row, i_lo)), 'c': _fnum(cell(row, i_c)),
                    'v': _fnum(cell(row, i_v), 0.0),
                    'oi': _fnum(cell(row, i_oi), 0.0),
                    'date': cell(row, i_date)})
    if not out:
        raise Exception('MCX bhavcopy has no data rows')
    return out


def nearest_expiry(rows, symbol):
    """Pick the nearest-expiry rows for ``symbol``. Pure.

    Returns (expiry_label, [rows]). Raises when the symbol is absent.
    """
    sym = str(symbol).upper()
    matching = [r for r in rows or [] if r.get('symbol') == sym]
    if not matching:
        raise Exception('MCX bhavcopy: symbol %s not present' % sym)
    dated = [r for r in matching if r.get('expiry_ms')]
    pool = dated or matching
    best = min(pool, key=lambda r: r.get('expiry_ms', 0))
    label = best.get('expiry') or 'spot'
    return label, [r for r in matching
                   if (r.get('expiry') or 'spot') == label]


def _mcx_cookie_header(set_cookie_values):
    pairs = []
    for value in set_cookie_values or []:
        first = str(value).split(';', 1)[0].strip()
        if '=' in first and first not in pairs:
            pairs.append(first)
    return '; '.join(pairs)


def _mcx_session_headers():
    """Open an MCX cookie+XSRF session. Returns header dict (may be thin).

    Best-effort: failures return {} and the bhavcopy fetch retries once
    after a refresh; a hard failure raises with reason at fetch time.
    """
    try:
        _body, headers = _http_get(MCX_HOME_URL)
    except Exception:
        return {}
    lowered = _lower_headers(headers)
    cookies = []
    for key, value in lowered.items():
        if key == 'set-cookie':
            if isinstance(value, list):
                cookies.extend(value)
            else:
                cookies.append(value)
    out = {}
    jar = _mcx_cookie_header(cookies)
    if jar:
        out['Cookie'] = jar
    xsrf = None
    for chunk in jar.split(';'):
        name, _, val = chunk.strip().partition('=')
        if name.strip().upper() in ('XSRF-TOKEN', 'X-XSRF-TOKEN'):
            xsrf = _urlparse.unquote(val.strip())
    if xsrf:
        out['X-XSRF-TOKEN'] = xsrf
    return out


def fetch_mcx_day(day, _get=None):
    """Fetch one MCX date-wise bhavcopy for ``day`` (403-tolerant retry)."""
    get = _get or _http_get
    params = {'d': day.strftime('%d-%m-%Y'),
              'date': day.strftime('%d-%m-%Y')}
    query = _urlparse.urlencode(params)
    url = MCX_BHAVCOPY_URL + '?' + query
    headers = _mcx_session_headers() if _get is None else {}
    try:
        body, _ = get(url, headers=headers or None)
        return body.decode('utf-8', errors='replace')
    except Exception as first:
        if '403' not in str(first):
            raise Exception('MCX GetDateWiseBhavCopy %s failed: %s'
                            % (day.isoformat(), first))
        # One retry after a session refresh; then degrade with reason.
        try:
            headers = _mcx_session_headers() if _get is None else {}
            body, _ = get(url, headers=headers or None)
            return body.decode('utf-8', errors='replace')
        except Exception as second:
            raise Exception('MCX GetDateWiseBhavCopy %s denied '
                            '(403 even after session refresh): %s'
                            % (day.isoformat(), second))


def fetch_mcx_series(symbol, limit=300, start=None, _fetch_day=None):
    """Build a nearest-expiry daily MCX series by walking date-wise files.

    CONTINUOUS-SERIES LIMITATION: each day uses that day's nearest-expiry
    contract, so expiry rolls appear as jumps -- this is a stitched
    snapshot series, not exchange-adjusted continuous history.
    """
    base = str(symbol or '').upper().split()[0]
    if not base:
        raise Exception('empty MCX symbol')
    limit = max(1, min(1000, int(limit or 300)))
    fetch = _fetch_day or fetch_mcx_day
    out, errors = [], []
    day = start if start is not None else _utc_today()
    guard, max_days = 0, limit * 3 + 20
    while len(out) < limit and guard < max_days:
        if day.weekday() < 5:
            try:
                rows = parse_mcx_bhavcopy(fetch(day))
                _label, picked = nearest_expiry(rows, base)
                row = picked[0]
                out.append({
                    't': int(datetime(day.year, day.month, day.day,
                                     tzinfo=timezone.utc).timestamp() * 1000),
                    'o': row['o'], 'h': row['h'], 'l': row['l'],
                    'c': row['c'], 'v': row['v']})
            except Exception as exc:
                errors.append('%s: %s' % (day.isoformat(), exc))
        day -= timedelta(days=1)
        guard += 1
    if not out:
        reason = errors[-1] if errors else 'symbol absent in recent files'
        raise Exception('MCX %s: no data (%s)' % (base, reason))
    out.sort(key=lambda c: c['t'])
    return out[-limit:]


# ---------------------------------------------------------------------------
# Local symbol lists (offline search fallback).
# ---------------------------------------------------------------------------

NIFTY_50 = [
    ('RELIANCE', 'Reliance Industries'), ('TCS', 'Tata Consultancy Services'),
    ('INFY', 'Infosys'), ('HDFCBANK', 'HDFC Bank'),
    ('ICICIBANK', 'ICICI Bank'), ('SBIN', 'State Bank of India'),
    ('BHARTIARTL', 'Bharti Airtel'), ('ITC', 'ITC'),
    ('KOTAKBANK', 'Kotak Mahindra Bank'), ('LT', 'Larsen & Toubro'),
    ('AXISBANK', 'Axis Bank'), ('MARUTI', 'Maruti Suzuki India'),
    ('M&M', 'Mahindra & Mahindra'), ('TITAN', 'Titan Company'),
    ('SUNPHARMA', 'Sun Pharmaceutical'), ('ULTRACEMCO', 'UltraTech Cement'),
    ('NTPC', 'NTPC'), ('POWERGRID', 'Power Grid Corporation'),
    ('ONGC', 'Oil & Natural Gas Corp'), ('TATAMOTORS', 'Tata Motors'),
    ('TATASTEEL', 'Tata Steel'), ('JSWSTEEL', 'JSW Steel'),
    ('HINDALCO', 'Hindalco Industries'), ('COALINDIA', 'Coal India'),
    ('BAJFINANCE', 'Bajaj Finance'), ('BAJAJFINSV', 'Bajaj Finserv'),
    ('HDFCLIFE', 'HDFC Life Insurance'), ('SBILIFE', 'SBI Life Insurance'),
    ('ADANIENT', 'Adani Enterprises'), ('ADANIPORTS', 'Adani Ports & SEZ'),
    ('APOLLOHOSP', 'Apollo Hospitals'), ('ASIANPAINT', 'Asian Paints'),
    ('BPCL', 'Bharat Petroleum'), ('BRITANNIA', 'Britannia Industries'),
    ('CIPLA', 'Cipla'), ('DIVISLAB', "Divi's Laboratories"),
    ('DRREDDY', "Dr Reddy's Laboratories"), ('EICHERMOT', 'Eicher Motors'),
    ('GRASIM', 'Grasim Industries'), ('HCLTECH', 'HCL Technologies'),
    ('HEROMOTOCO', 'Hero MotoCorp'), ('HINDUNILVR', 'Hindustan Unilever'),
    ('INDUSINDBK', 'IndusInd Bank'), ('NESTLEIND', 'Nestle India'),
    ('SBIN', 'State Bank of India'), ('SHRIRAMFIN', 'Shriram Finance'),
    ('TATACONSUM', 'Tata Consumer Products'), ('TECHM', 'Tech Mahindra'),
    ('TRENT', 'Trent'), ('WIPRO', 'Wipro'),
]

NSE_INDICES = [
    ('NIFTY 50', 'Nifty 50 index'), ('NIFTY BANK', 'Nifty Bank index'),
    ('NIFTY IT', 'Nifty IT index'), ('INDIA VIX', 'India VIX volatility'),
    ('NIFTY NEXT 50', 'Nifty Next 50 index'),
    ('NIFTY MIDCAP 50', 'Nifty Midcap 50 index'),
]

BSE_KNOWN = [
    ('500325', 'Reliance Industries'), ('532540', 'Tata Consultancy Services'),
    ('500209', 'Infosys'), ('500180', 'HDFC Bank'),
    ('532174', 'ICICI Bank'), ('500112', 'State Bank of India'),
    ('500875', 'ITC'), ('500820', 'Asian Paints'),
    ('500696', 'Hindustan Unilever'), ('500570', 'Tata Motors'),
]

MCX_KNOWN = [
    ('GOLD', 'Gold futures'), ('SILVER', 'Silver futures'),
    ('CRUDEOIL', 'Crude Oil futures'), ('NATURALGAS', 'Natural Gas futures'),
    ('COPPER', 'Copper futures'), ('ALUMINIUM', 'Aluminium futures'),
    ('LEAD', 'Lead futures'), ('NICKEL', 'Nickel futures'),
    ('ZINC', 'Zinc futures'), ('MENTHAOIL', 'Mentha Oil futures'),
]

MF_KNOWN = [
    ('119062', 'Parag Parikh Flexi Cap Fund - Growth'),
    ('120586', 'Axis Bluechip Fund - Growth'),
    ('101206', 'SBI Bluechip Fund - Growth'),
]


def filter_local_symbols(query, entries, limit=20):
    """Case-insensitive substring match over [(symbol, name)]. Pure."""
    q = str(query or '').strip().upper()
    if not q:
        return []
    scored = []
    for symbol, name in entries or []:
        sym, nm = str(symbol).upper(), str(name).upper()
        if q == sym:
            scored.append((0, symbol, name))
        elif sym.startswith(q):
            scored.append((1, symbol, name))
        elif q in sym or q in nm:
            scored.append((2, symbol, name))
    scored.sort(key=lambda s: (s[0], s[1]))
    return [{'symbol': sym, 'name': nm} for _, sym, nm in scored[:limit]]


def _mcp_search(query, timeout=8):
    client = NseMcp(timeout=timeout)
    result = client.call(_MCP_TOOL_SEARCH, {'query': query, 'q': query})
    items = result if isinstance(result, list) else _history_rows(result)
    if isinstance(result, dict):
        for key in ('symbols', 'matches', 'results', 'suggestions'):
            if isinstance(result.get(key), list):
                items = result[key]
                break
    out = []
    for item in items or []:
        if isinstance(item, str):
            out.append({'symbol': item.upper(), 'name': item})
        elif isinstance(item, dict):
            sym = (item.get('symbol') or item.get('SYMBOL')
                   or item.get('name') or '')
            name = (item.get('name') or item.get('companyName')
                    or item.get('COMPANY') or sym)
            if sym:
                out.append({'symbol': str(sym).upper(), 'name': str(name)})
    return out


# ---------------------------------------------------------------------------
# Symbol validation (per-source tightening of the server regex).
# ---------------------------------------------------------------------------

_ALLOWED_SYMBOL_CHARS = set(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    '0123456789.-_/: ')


def _clean_symbol(symbol, allow_space=False):
    if symbol is None:
        raise Exception('empty symbol for source india')
    text = str(symbol).strip()
    if not text:
        raise Exception('empty symbol for source india')
    if len(text) > 64:
        raise Exception('symbol too long (max 64 chars): %r' % (symbol,))
    for ch in text:
        if ch not in _ALLOWED_SYMBOL_CHARS or (ch == ' ' and not allow_space):
            raise Exception('invalid symbol %r for source india '
                            '(A-Za-z0-9 . - _ / : and space only)' % (symbol,))
    text = text.upper()
    if text.endswith('.NS'):
        text = text[:-3]
    return text


def _is_index_symbol(symbol):
    sym = ' '.join(str(symbol or '').upper().split())
    if sym in ('NIFTY', 'NIFTY50'):
        return True
    return any(sym == name for name, _ in NSE_INDICES)


# ---------------------------------------------------------------------------
# Contract entry points.
# ---------------------------------------------------------------------------

def _nse_candles(symbol, limit, _client=None, _fetch_day=None):
    sym = _clean_symbol(symbol, allow_space=True)
    try:
        client = _client if _client is not None else NseMcp()
        if _is_index_symbol(sym):
            rows = fetch_index_history(sym, _client=client)
        else:
            rows = fetch_stock_history(sym, _client=client)
        actions = fetch_corporate_actions(sym, _client=client)
        if actions:
            rows = apply_adjustments(rows, actions)
        return rows[-limit:]
    except Exception as mcp_err:
        fetch = _fetch_day
        if fetch is None:
            def fetch(day, _sym=sym):
                return fetch_nse_archive_day(_sym, day)
        try:
            return build_series_from_daily(fetch, limit)
        except Exception as arch_err:
            raise Exception('NSE %s: MCP history failed (%s); '
                            'EOD-archive fallback failed (%s)'
                            % (sym, mcp_err, arch_err))


def _bse_candles(symbol, limit, _fetch_day=None):
    sym = _clean_symbol(symbol)
    # Accept a known short name by mapping it to its scrip code first.
    for code, name in BSE_KNOWN:
        if sym == name.upper().replace(' ', '').replace('.', ''):
            sym = code
            break
    fetch = _fetch_day
    if fetch is None:
        def fetch(day, _sym=sym):
            return fetch_bse_archive_day(_sym, day)
    try:
        return build_series_from_daily(fetch, limit)
    except Exception as exc:
        raise Exception('BSE %s: EOD-archive series failed (%s)' % (sym, exc))


def _mf_candles(symbol, limit):
    return fetch_nav_series(symbol, limit)


def candles(venue, symbol, interval='1d', limit=300):
    """Return ascending daily [{t,o,h,l,c,v}] for venue/symbol.

    Only '1d' is accepted. Routes: NSE -> MCP history (EOD-archive
    fallback); BSE -> EOD archives by scrip code/name; MCX -> date-wise
    bhavcopy nearest-expiry series; MF-NAV -> NAV lines. NCDEX raises
    'unsupported market'.
    """
    if interval not in INTERVALS:
        raise Exception("unsupported interval %r for source 'india'; "
                        'supported: %s' % (interval, INTERVALS))
    v = str(venue or '').strip().upper().replace('_', '-')
    if v in ('MFNAV', 'MF', 'MUTUALFUND'):
        v = 'MF-NAV'
    limit = max(1, min(1000, int(limit or 300)))
    if v == 'NSE':
        return _nse_candles(symbol, limit)
    if v == 'BSE':
        return _bse_candles(symbol, limit)
    if v == 'MCX':
        return fetch_mcx_series(str(symbol or '').upper().split()[0] or symbol,
                                limit)
    if v == 'MF-NAV':
        return _mf_candles(symbol, limit)
    if v == 'NCDEX':
        raise Exception('NCDEX: unsupported market (no keyless direct '
                        'route in this source)')
    raise Exception('unknown venue %r for source india; supported: %s'
                    % (venue, _SUPPORTED_VENUES))


def search(venue, query):
    """Search symbols: NSE via MCP ``search_symbols`` with a local NIFTY
    fallback; BSE/MCX via local lists; MF-NAV via AMFI names (network) or
    known codes."""
    q = str(query or '').strip()
    if not q:
        return []
    v = str(venue or 'NSE').strip().upper().replace('_', '-')
    if v in ('MFNAV', 'MF', 'MUTUALFUND'):
        v = 'MF-NAV'
    if v == 'NSE':
        try:
            found = _mcp_search(q)
            if found:
                return found[:20]
        except Exception:
            pass
        return filter_local_symbols(q, NIFTY_50 + NSE_INDICES)
    if v == 'BSE':
        return filter_local_symbols(
            q, [(c, n) for c, n in BSE_KNOWN] +
            [(s, n) for s, n in NIFTY_50])
    if v == 'MCX':
        return filter_local_symbols(q, MCX_KNOWN)
    if v == 'MF-NAV':
        if q[0].isdigit():
            return filter_local_symbols(q, MF_KNOWN)
        try:
            body, _ = _http_get(AMFI_NAV_URL)
            funds = parse_nav_all(body.decode('utf-8', errors='replace'))
            entries = [(code, info['name']) for code, info in funds.items()]
            return [{'symbol': c, 'name': n}
                    for c, n in filter_local_symbols(q, entries)]
        except Exception as exc:
            known = filter_local_symbols(q, MF_KNOWN)
            if known:
                return known
            raise Exception('MF-NAV search needs network (AMFI navAll.txt '
                            'unreachable: %s)' % exc)
    if v == 'NCDEX':
        raise Exception('NCDEX: unsupported market (no keyless direct '
                        'route in this source)')
    raise Exception('unknown venue %r for source india; supported: %s'
                    % (venue, _SUPPORTED_VENUES))

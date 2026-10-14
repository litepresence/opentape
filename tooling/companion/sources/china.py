"""China A-shares companion source (workstream H).

Primary: baostock history (daily/weekly/monthly + 5/15/30/60-minute),
adjusted. Secondary: akshare eastmoney history (daily/weekly/monthly via
``stock_zh_a_hist``, intraday via ``stock_zh_a_hist_min_em``) + full-market
spot snapshot (``stock_zh_a_spot_em``) for search/quote enrichment.

API conventions below were verified against the real wheels
(baostock 0.9.4, akshare 1.18.88) — every optional-dep call site is still
guarded with hasattr and raises a clear mismatch error, so a future
upstream rename degrades loudly instead of charting wrong data.

baostock (verified): ``login()`` / ``logout()`` /
``query_history_k_data_plus(code, fields, start_date, end_date,
frequency, adjustflag)``; frequency in {"d","w","m","5","15","30","60"};
ResultData with ``error_code == '0'``, ``next()``, ``get_row_data()``
(positional values aligned with ``rs.fields``), ``fields``. Daily fields
start with ``date``; minute fields carry ``date`` + ``time`` separately.
adjustflag: "1" = 后复权 (backward-adjusted), "2" = 前复权
(forward-adjusted, the default here — continuous charts), "3" = 不复权
(unadjusted, the baostock default). akshare uses the matching
``adjust`` values "hfq" / "qfq" / "".

akshare (verified): ``stock_zh_a_hist(symbol=<bare 6-digit>,
period=daily|weekly|monthly, start_date=YYYYMMDD, end_date=YYYYMMDD,
adjust=''|qfq|hfq)`` -> columns 日期,开盘,收盘,最高,最低,成交量,...;
``stock_zh_a_hist_min_em(symbol, start_date, end_date,
period='1'|'5'|'15'|'30'|'60', adjust)`` -> columns 时间,开盘,收盘,最高,
最低,成交量,...; ``stock_zh_a_spot_em()`` (no args) -> columns 代码,名称,
最新价,最高,最低,今开,昨收,成交量,...; ``stock_info_a_code_name()``
(no args) -> columns code,name.

Stdlib only in this file. baostock + akshare are pip-OPTIONAL: absent
(or broken) installs degrade to a clear 'backend missing' error with an
install hint — the module still imports and the server stays up.

Honesty notes (live-only, never substitute data):
- A-shares are T+1: the latest daily bar is the last *closed* session,
  and intraday bars are delayed snapshots — see STREAM['note'].
- Volume units are backend-native and NOT rescaled (baostock reports
  shares, eastmoney/akshare reports lots); mixing backends across
  refetches can step volume — prices are unaffected.
- Naive datetimes are session time (Asia/Shanghai, UTC+8); date-only
  values are UTC midnight. Documented so normalize stays deterministic.
- Yahoo ``.SS`` / ``.SZ`` tickers cover the same market but are NOT
  fetched here — source ``yahoo`` (workstream C) already maps those
  suffixes. Likewise venue ``HK`` is listed for discovery but raises
  here with a pointer to the yahoo ``.HK`` path.
"""

import datetime as _dt
import math as _math
import re as _re

SOURCE = 'china'
LABEL = 'China A-shares'
# Baostock granularities only: 5/15/30/60-minute + d/w/m. There is no 1m
# product — '1m' is rejected with this supported list.
INTERVALS = ['5m', '15m', '30m', '1h', '1d', '1wk', '1mo']
STREAM = {'mode': 'snapshot', 'cadence': 300, 'note': 'T+1 EOD; intraday delayed'}

INSTALL_HINT = 'pip install baostock akshare'
_BACKEND_MISSING = (
    'china: backend missing (baostock/akshare not installed; %s)' % INSTALL_HINT
)

try:
    import baostock as _bs
except Exception:
    # Pip-optional: degrade with an install hint, never crash the server.
    _bs = None

try:
    import akshare as _ak
except Exception:
    _ak = None

# Forward-adjusted continuity for charts; akshare equivalent "qfq".
BAOSTOCK_ADJUSTFLAG = '2'
AKSHARE_ADJUST = 'qfq'

# Verified baostock frequency ids (0.9.4 demo_A_stock_k_data / 5m demo).
_BS_FREQUENCY = {
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '1d': 'd',
    '1wk': 'w',
    '1mo': 'm',
}
# Verified akshare period values (stock_hist_em.py signatures).
_AK_DAILY_PERIOD = {'1d': 'daily', '1wk': 'weekly', '1mo': 'monthly'}
_AK_MIN_PERIOD = {'5m': '5', '15m': '15', '30m': '30', '1h': '60'}
_BS_MIN_FIELDS = 'date,time,code,open,high,low,close,volume,amount,adjustflag'
_BS_DAY_FIELDS = 'date,code,open,high,low,close,volume,amount,adjustflag'

_SESSION_TZ = _dt.timezone(_dt.timedelta(hours=8), name='CST')

# Prefix -> (first-digit set, exchange MIC-ish label).
_PREFIX_RULES = {
    'sh': (frozenset('6'), 'SSE'),
    'sz': (frozenset('03'), 'SZSE'),
    'bj': (frozenset('489'), 'BSE'),
}
_CODE_RE = _re.compile(r'^(?:(sh|sz|bj)\.?)?(\d{1,6})$', _re.IGNORECASE)

# Column aliases: baostock English first, then akshare Chinese.
_T_KEYS = ('date', '日期', 'time', '时间', 'datetime', 'datetime64')
_O_KEYS = ('open', '开盘', '开盘价', '今开')
_H_KEYS = ('high', '最高', '最高价')
_L_KEYS = ('low', '最低', '最低价')
_C_KEYS = ('close', '收盘', '收盘价', '最新价', '昨收')
_V_KEYS = ('volume', '成交量', 'vol', '成交股数')


def venues():
    """Return venue descriptors (CN-A live here; HK discovered, served via yahoo)."""
    return [
        {'id': 'CN-A', 'label': 'China A-shares (SSE/SZSE/BSE)'},
        {'id': 'HK', 'label': 'Hong Kong (.HK via yahoo source)'},
    ]


def validate_interval(interval):
    """Return the interval or raise with the supported list (no 1m product)."""
    if interval not in INTERVALS:
        raise ValueError(
            'china: unsupported interval %r (supported: %s)'
            % (interval, ', '.join(INTERVALS))
        )
    return interval


def baostock_frequency_for(interval):
    """Map a validated interval to the baostock frequency id."""
    return _BS_FREQUENCY[validate_interval(interval)]


def _classify_bare(code6):
    for prefix, (digits, _exch) in _PREFIX_RULES.items():
        if code6[0] in digits:
            return prefix
    return None


def canonical_symbol(symbol):
    """Normalize to lowercase ``<prefix>.<6 digits>``, guessing bare codes.

    Prefix digit sets are enforced (sh->6, sz->0/3, bj->4/8/9); anything
    else raises so a mislabeled market never charts silently.
    """
    if symbol is None:
        raise ValueError('china: empty symbol (expected sh./sz./bj. + 6 digits)')
    text = _re.sub(r'\s+', '', str(symbol)).lower()
    m = _CODE_RE.match(text)
    if not m or len(m.group(2)) != 6:
        raise ValueError(
            'china: unroutable symbol %r (expected sh.6xxxxx / sz.0xxxxx,3xxxxx / '
            'bj.4xxxxx,8xxxxx,9xxxxx)' % (symbol,)
        )
    prefix, code6 = m.group(1), m.group(2)
    if prefix is None:
        prefix = _classify_bare(code6)
        if prefix is None:
            raise ValueError(
                'china: cannot route bare code %r (no sh/sz/bj prefix guess; '
                'use an explicit sh./sz./bj. prefix)' % (symbol,)
            )
    digits, _exch = _PREFIX_RULES[prefix]
    if code6[0] not in digits:
        raise ValueError(
            'china: prefix %r does not match code %r '
            '(sh->6, sz->0/3, bj->4/8/9)' % (prefix, code6)
        )
    return '%s.%s' % (prefix, code6)


def route_code(symbol):
    """Route a symbol to per-backend codes + exchange label.

    baostock keeps the ``sh.600000`` prefixed form; akshare takes the bare
    ``600000`` (``stock_zh_a_hist(symbol='600000')`` convention).
    """
    canon = canonical_symbol(symbol)
    prefix, code6 = canon.split('.')
    _digits, exch = _PREFIX_RULES[prefix]
    return {
        'canonical': canon,
        'baostock': canon,
        'akshare': code6,
        'exchange': exch,
    }


def baostock_code_for(symbol):
    """Prefixed baostock code (``sh.600000``)."""
    return route_code(symbol)['baostock']


def akshare_symbol_for(symbol):
    """Bare akshare code (``600000``)."""
    return route_code(symbol)['akshare']


def parse_time_to_ms(value):
    """Parse a baostock/akshare timestamp to epoch ms (int).

    Date-only -> UTC midnight; naive datetimes -> Asia/Shanghai session
    time; aware datetimes converted; epoch numbers auto-detect s/ms.
    """
    if isinstance(value, _dt.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=_SESSION_TZ)
        return int(value.timestamp() * 1000)
    if isinstance(value, _dt.date):
        value = value.isoformat()
    if isinstance(value, bool):
        raise ValueError('bad time %r' % (value,))
    if isinstance(value, (int, float)):
        if not _math.isfinite(value):
            raise ValueError('bad time %r' % (value,))
        v = float(value)
        # s (<1e11) vs ms heuristic; companion contract uses ms.
        ms = v * 1000.0 if v < 1e11 else v
        return int(ms)
    text = str(value).strip()
    if not text:
        raise ValueError('empty time')
    # Compact forms first: YYYYMMDD[HHMMSS].
    m = _re.match(r'^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$', text)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if m.group(4) is None:
            dt = _dt.datetime(y, mo, d, tzinfo=_dt.timezone.utc)
        else:
            dt = _dt.datetime(
                y, mo, d, int(m.group(4)), int(m.group(5)), int(m.group(6)),
                tzinfo=_SESSION_TZ,
            )
        return int(dt.timestamp() * 1000)
    iso = text.replace('/', '-').replace('T', ' ')
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try:
            dt = _dt.datetime.strptime(iso, fmt)
            if fmt == '%Y-%m-%d':
                dt = dt.replace(tzinfo=_dt.timezone.utc)
            else:
                dt = dt.replace(tzinfo=_SESSION_TZ)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError('unparseable time %r' % (value,))


def _pick(row, keys):
    lower = {}
    for k, v in row.items():
        lower[str(k).lower()] = v
    for key in keys:
        hit = key.lower() in lower
        if not hit:
            continue
        v = lower[key.lower()]
        if v is None:
            continue
        if isinstance(v, str) and v.strip() in ('', '--', 'nan', 'NaN', 'None'):
            continue
        return v
    return None


def _num(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if _math.isfinite(value) else None
    text = str(value).strip().replace(',', '')
    if text in ('', '--'):
        return None
    try:
        f = float(text)
    except ValueError:
        return None
    return f if _math.isfinite(f) else None


def normalize_rows(rows):
    """Normalize backend row-dicts (English or Chinese keys) to candles.

    Input is plain ``[{...}]`` (DataFrame-likes as lists/dicts — no pandas
    here, so offline fixtures stay dependency-free). Baostock minute rows
    carry ``date`` + ``time`` separately and are combined. Rows missing any
    of o/h/l/c (e.g. baostock ``''`` on suspended days) are skipped.
    Output is ascending ``[{t,o,h,l,c,v}]`` with integer ms ``t``.
    """
    out = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        t_raw = _pick(row, _T_KEYS)
        # Baostock minute bars: date + time are separate columns.
        t_extra = _pick(row, ('time',)) if t_raw is not None else None
        date_raw = _pick(row, ('date', '日期'))
        if (
            t_extra is not None
            and date_raw is not None
            and str(date_raw).strip()
            and str(t_extra).strip()
            and len(str(date_raw).strip()) <= 10
        ):
            t_raw = '%s %s' % (str(date_raw).strip(), str(t_extra).strip())
        o = _num(_pick(row, _O_KEYS))
        h = _num(_pick(row, _H_KEYS))
        l = _num(_pick(row, _L_KEYS))
        c = _num(_pick(row, _C_KEYS))
        v = _num(_pick(row, _V_KEYS))
        if o is None or h is None or l is None or c is None:
            continue
        try:
            t = parse_time_to_ms(t_raw)
        except (ValueError, TypeError, OverflowError):
            continue
        out.append({'t': t, 'o': o, 'h': h, 'l': l, 'c': c, 'v': v if v is not None else 0.0})
    out.sort(key=lambda b: b['t'])
    return out


def match_code_pattern(query):
    """Offline code-pattern search fallback (no registry needed).

    Full ``sh.600000``-style or bare 6-digit codes route to a canonical
    guess list (ambiguous first digits yield sh/sz/bj guesses); partial
    codes and names need the akshare registry and return [] here.
    """
    if query is None:
        return []
    text = _re.sub(r'\s+', '', str(query)).lower()
    if not text:
        return []
    m = _CODE_RE.match(text)
    if not m or len(m.group(2)) != 6:
        return []
    prefix, code6 = m.group(1), m.group(2)
    if prefix is not None:
        try:
            canon = canonical_symbol(text)
        except ValueError:
            return []
        return [{'symbol': canon, 'name': canon}]
    guess = _classify_bare(code6)
    if guess is not None:
        canon = '%s.%s' % (guess, code6)
        return [{'symbol': canon, 'name': canon}]
    return [
        {'symbol': '%s.%s' % (p, code6), 'name': '%s.%s (guess)' % (p, code6)}
        for p in ('sh', 'sz', 'bj')
    ]


def build_baostock_window(today, interval, limit):
    """Pure date-window math: (start_YYYY-MM-DD, end_YYYY-MM-DD).

    Buffers ~2x for weekends/holidays (baostock skips non-sessions, so
    over-fetch then trim to ``limit``); intraday windows derive trading
    days from a 240-minute session.
    """
    validate_interval(interval)
    n = max(1, min(int(limit), 1000))
    if interval == '1d':
        days = n * 2 + 10
    elif interval == '1wk':
        days = n * 7 * 2 + 14
    elif interval == '1mo':
        days = n * 31 * 2 + 31
    else:
        mins = {'5m': 5, '15m': 15, '30m': 30, '1h': 60}[interval]
        days = -(-n * mins // 240) * 2 + 10  # ceil sessions, buffered
    start = today - _dt.timedelta(days=days)
    return (start.isoformat(), today.isoformat())


def _require_baostock():
    if _bs is None:
        raise Exception(_BACKEND_MISSING)
    for attr in ('login', 'logout', 'query_history_k_data_plus'):
        if not hasattr(_bs, attr):
            raise Exception(
                'china: baostock API mismatch (missing %r; need %s)' % (attr, INSTALL_HINT)
            )
    return _bs


def _require_akshare(*attrs):
    if _ak is None:
        raise Exception(_BACKEND_MISSING)
    for attr in attrs:
        if not hasattr(_ak, attr):
            raise Exception(
                'china: akshare API mismatch (missing %r; need %s)' % (attr, INSTALL_HINT)
            )
    return _ak


def _records(df_like, where):
    if df_like is None:
        return []
    if hasattr(df_like, 'to_dict'):
        try:
            return list(df_like.to_dict('records'))
        except Exception as exc:
            raise Exception('china: akshare API mismatch (%s frame: %s)' % (where, exc))
    if isinstance(df_like, (list, tuple)):
        return list(df_like)
    raise Exception('china: akshare API mismatch (unexpected %s frame)' % where)


def _baostock_candles(bs, code, interval, limit):
    freq = baostock_frequency_for(interval)
    fields = _BS_MIN_FIELDS if freq in ('5', '15', '30', '60') else _BS_DAY_FIELDS
    today = _dt.date.today()
    start, end = build_baostock_window(today, interval, limit)
    lg = bs.login()
    if str(getattr(lg, 'error_code', '')) != '0':
        raise Exception(
            'china: baostock login failed (%s)' % getattr(lg, 'error_msg', 'unknown')
        )
    try:
        # Keyword names verified against baostock 0.9.4; adjustflag="2"
        # (前复权) is this module's documented default.
        rs = bs.query_history_k_data_plus(
            code=code,
            fields=fields,
            start_date=start,
            end_date=end,
            frequency=freq,
            adjustflag=BAOSTOCK_ADJUSTFLAG,
        )
        if str(getattr(rs, 'error_code', '')) != '0':
            raise Exception(
                'china: baostock query failed (%s)' % getattr(rs, 'error_msg', 'unknown')
            )
        names = [str(f) for f in (getattr(rs, 'fields', []) or [])]
        rows = []
        while rs.next():
            item = rs.get_row_data()
            if isinstance(item, dict):
                rows.append(item)
            else:
                rows.append(dict(zip(names, list(item))))
    finally:
        try:
            bs.logout()
        except Exception:
            pass
    bars = normalize_rows(rows)
    if not bars:
        raise Exception('china: baostock returned no candles for %s %s' % (code, interval))
    return bars[-limit:]


def _akshare_candles(aksym, interval, limit):
    today = _dt.date.today()
    start_d, end_d = build_baostock_window(today, interval, limit)
    compact_start = start_d.replace('-', '')
    compact_end = end_d.replace('-', '')
    if interval in _AK_DAILY_PERIOD:
        ak = _require_akshare('stock_zh_a_hist')
        # Signature verified against akshare 1.18.88 (stock_hist_em.py).
        df = ak.stock_zh_a_hist(
            symbol=aksym,
            period=_AK_DAILY_PERIOD[interval],
            start_date=compact_start,
            end_date=compact_end,
            adjust=AKSHARE_ADJUST,
        )
        rows = _records(df, 'stock_zh_a_hist')
    else:
        ak = _require_akshare('stock_zh_a_hist_min_em')
        df = ak.stock_zh_a_hist_min_em(
            symbol=aksym,
            period=_AK_MIN_PERIOD[validate_interval(interval)],
            start_date='%s 09:30:00' % start_d,
            end_date='%s 15:00:00' % end_d,
            adjust=AKSHARE_ADJUST,
        )
        rows = _records(df, 'stock_zh_a_hist_min_em')
    bars = normalize_rows(rows)
    if not bars:
        raise Exception('china: akshare returned no candles for %s %s' % (aksym, interval))
    return bars[-limit:]


def candles(venue, symbol, interval, limit=300):
    """Return ascending [{t,o,h,l,c,v}]; raise Exception(detail) on failure.

    Baostock history first, akshare second; when both backends are absent
    (or their APIs mismatch) the error says so with an install hint —
    never another market's bars.
    """
    validate_interval(interval)
    route = route_code(symbol)
    if venue == 'HK' or (isinstance(venue, str) and venue.strip().upper() == 'HK'):
        raise Exception('china: HK quotes not implemented here (use source yahoo, .HK suffix)')
    if venue not in (None, '', 'CN-A'):
        raise Exception('china: unknown venue %r (venues: CN-A, HK)' % (venue,))
    try:
        n = max(1, min(int(limit), 1000))
    except (TypeError, ValueError):
        n = 300
    if _bs is None and _ak is None:
        raise Exception(_BACKEND_MISSING)
    last_error = None
    if _bs is not None:
        try:
            _require_baostock()
            return _baostock_candles(_bs, route['baostock'], interval, n)
        except Exception as exc:
            last_error = exc
            if _ak is None:
                raise
    try:
        _require_akshare()
        return _akshare_candles(route['akshare'], interval, n)
    except Exception as exc:
        if last_error is not None and 'backend missing' not in str(exc):
            raise Exception(
                'china: baostock failed (%s); akshare fallback failed (%s)'
                % (last_error, exc)
            )
        if last_error is not None:
            raise last_error
        raise


def search(venue, query):
    """Search A-share codes/names; akshare registry when present, else pattern."""
    q = '' if query is None else str(query).strip()
    if not q:
        return []
    if _ak is not None and hasattr(_ak, 'stock_info_a_code_name'):
        try:
            recs = _records(_ak.stock_info_a_code_name(), 'stock_info_a_code_name')
            out = []
            ql = q.lower()
            for rec in recs:
                if not isinstance(rec, dict):
                    continue
                code = _pick(rec, ('code', '代码', '证券代码', '股票代码', 'A股代码'))
                name = _pick(rec, ('name', '名称', '证券简称', '股票简称', 'A股简称'))
                code_s = '' if code is None else str(code).strip()
                name_s = '' if name is None else str(name).strip()
                if not code_s or (ql not in code_s.lower() and q not in name_s):
                    continue
                try:
                    canon = canonical_symbol(code_s)
                except ValueError:
                    continue
                out.append({'symbol': canon, 'name': name_s or canon})
                if len(out) >= 50:
                    break
            return out
        except Exception:
            pass  # fall through to the offline pattern matcher
    return match_code_pattern(q)


def quote(venue, symbol):
    """Spot quote via akshare's full-market snapshot (optional contract hook)."""
    route = route_code(symbol)
    ak = _require_akshare('stock_zh_a_spot_em')
    recs = _records(ak.stock_zh_a_spot_em(), 'stock_zh_a_spot_em')
    for rec in recs:
        if not isinstance(rec, dict):
            continue
        code = _pick(rec, ('代码', 'code', '证券代码'))
        if code is None or str(code).strip() != route['akshare']:
            continue
        price = _num(_pick(rec, ('最新价', '收盘', 'close')))
        if price is None:
            raise Exception('china: akshare spot row lacks 最新价 for %s' % route['canonical'])
        out = {'symbol': route['canonical'], 'price': price}
        name = _pick(rec, ('名称', 'name'))
        if name is not None:
            out['name'] = str(name)
        for key, aliases in (
            ('open', ('今开', '开盘', 'open')),
            ('high', ('最高', 'high')),
            ('low', ('最低', 'low')),
            ('prev_close', ('昨收', 'preclose')),
            ('volume', ('成交量', 'volume')),
        ):
            v = _num(_pick(rec, aliases))
            if v is not None:
                out[key] = v
        return out
    raise Exception('china: %s not in akshare spot snapshot' % route['canonical'])

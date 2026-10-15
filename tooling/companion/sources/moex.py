"""MOEX ISS source for the Opentape companion.

Moscow Exchange Informational & Statistical Server (ISS) — keyless public
JSON fetched with stdlib ``urllib`` only (no SDK, no secrets, no order
routing; GET-only display data). Clean-room implementation against the
public ISS URL shapes; verified live 2026-10-14.

Jurisdiction note: MOEX/NCC/NSD US/UK SDN-listed; read-only display, no
order routing. This module never sends orders, holds custody, or routes
anything — it only reads public price history for chart display.

Coverage (one venue per market leg; board overridable per symbol)::

    MOEX-SHARES  engine=stock    market=shares  board=TQBR  (e.g. SBER)
    MOEX-INDEX   engine=stock    market=index   board=SNDX  (e.g. IMOEX)
    MOEX-FX      engine=currency market=selt    board=CETS  (e.g. CNY000UTSTOM,
                 fixings such as CNYFIXME are plain instrument codes)
    MOEX-OFZ     engine=stock    market=bonds   board=TQOB  (e.g. SU26238RMFS4)
    MOEX-FORTS   engine=futures  market=forts   board=RFUD  (e.g. Si-12.25)

A symbol may carry an explicit board as ``BOARD/SECID`` (e.g.
``TQBR/SBER``); otherwise the venue default board is used.

Endpoints (BASE = https://iss.moex.com/iss/)::

    history  /history/engines/<e>/markets/<m>/boards/<b>/securities/<s>.json
             ?from=&till=  (daily bars; ``start=`` pages via history.cursor)
    candles  /engines/<e>/markets/<m>/boards/<b>/securities/<s>/candles.json
             ?from=&till=&interval=  (ISS codes: 1/10/60 min, 24 day, 7 week,
             31 month; ``start=`` pages via candles.cursor)
    aggregates  /securities/<s>/aggregates.json  (daily shortcut / fallback)
    orderbook   /engines/.../securities/<s>/orderbook.json  (officially
                subscribers-only: empty/denied answers are honest degraded
                errors here, never faked books)
    trades      /engines/.../securities/<s>/trades.json  (recent tape)
    search      /securities.json?q=...

Live-only honesty: every fetch raises ``Exception(detail)`` on failure —
empty history surfaces "history unavailable" (survivorship: delisted/
unknown tickers are never silent, never another market's bars).

Politeness: >=0.25s between live requests (<=4 req/s, inside the 5 req/s
budget), ``iss.only`` column slimming, ``iss.meta=off``, browser-like UA
(anecdotal ISS throttling of bare clients).
"""

import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError

SOURCE = 'moex'
LABEL = 'Moscow Exchange (MOEX)'
INTERVALS = ['1m', '10m', '1h', '1d', '1w', '1M']
STREAM = {'mode': 'poll', 'cadence': 300,
          'note': ('poll ~5m; EOD history daily; MOEX/NCC/NSD US/UK SDN-listed; '
                   'read-only display, no order routing')}

BASE = 'https://iss.moex.com/iss/'

_HTTP_TIMEOUT = 15
_MIN_GAP = 0.25  # seconds between live requests (<=4 req/s)
_LAST_TS = [0.0]

_UA = ('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) '
       'Gecko/20100101 Firefox/128.0')

_VENUES = [
    {'id': 'MOEX-SHARES', 'label': 'MOEX Shares (TQBR)'},
    {'id': 'MOEX-INDEX', 'label': 'MOEX Indices (SNDX)'},
    {'id': 'MOEX-FX', 'label': 'MOEX FX (CETS)'},
    {'id': 'MOEX-OFZ', 'label': 'MOEX OFZ Bonds (TQOB)'},
    {'id': 'MOEX-FORTS', 'label': 'MOEX FORTS Futures (RFUD)'},
]
_VENUE_IDS = frozenset(v['id'] for v in _VENUES)

_ROUTES = {
    'MOEX-SHARES': {'engine': 'stock', 'market': 'shares', 'board': 'TQBR'},
    'MOEX-INDEX': {'engine': 'stock', 'market': 'index', 'board': 'SNDX'},
    'MOEX-FX': {'engine': 'currency', 'market': 'selt', 'board': 'CETS'},
    'MOEX-OFZ': {'engine': 'stock', 'market': 'bonds', 'board': 'TQOB'},
    'MOEX-FORTS': {'engine': 'futures', 'market': 'forts', 'board': 'RFUD'},
}

# Terminal interval -> ISS candles interval code (minutes 1/10/60,
# day 24, week 7, month 31).
_ISS_INTERVAL = {'1m': 1, '10m': 10, '1h': 60, '1d': 24, '1w': 7, '1M': 31}
_INTERVAL_SECS = {'1m': 60, '10m': 600, '1h': 3600,
                  '1d': 86400, '1w': 604800, '1M': 2592000}

_SYM_RE = re.compile(r'^[A-Za-z0-9.\-=^:/]{1,64}$')
_BOARD_RE = re.compile(r'^[A-Za-z0-9]{1,12}$')

_BID_MARKS = frozenset(('B', 'BUY', 'BID'))
_ASK_MARKS = frozenset(('S', 'SELL', 'ASK', 'OFFER'))


# ---------------------------------------------------------------- venues ---

def venues():
    """Return [{id, label}] for the five MOEX market legs."""
    return [dict(v) for v in _VENUES]


# ------------------------------------------------------------- pure helpers ---

def iss_interval(interval):
    """Map a terminal interval to its ISS candles code; raise otherwise."""
    try:
        return _ISS_INTERVAL[interval]
    except KeyError:
        raise Exception(
            'unsupported interval %r; supported: %s'
            % (interval, ', '.join(INTERVALS)))


def route_for(venue):
    """Return the engine/market/board triple for a venue id."""
    try:
        return dict(_ROUTES[venue])
    except KeyError:
        raise Exception(
            'unknown venue %r; expected one of: %s'
            % (venue, ', '.join(sorted(_VENUE_IDS))))


def resolve(venue, symbol):
    """Resolve (venue, symbol) to engine/market/board/secid.

    ``BOARD/SECID`` overrides the venue default board (e.g. fixings or
    alternate boards); otherwise the venue default applies.
    """
    route = route_for(venue)
    s = (symbol or '').strip()
    if not s:
        raise Exception('empty symbol')
    if not _SYM_RE.match(s):
        raise Exception(
            "invalid symbol %r; use MOEX secids (letters, digits, '.-=/^:') and "
            'optional BOARD/ prefix' % s)
    board = route['board']
    sec = s
    if '/' in s:
        prefix, rest = s.split('/', 1)
        if not rest.strip():
            raise Exception('empty secid after board prefix in %r' % s)
        if not _BOARD_RE.match(prefix):
            raise Exception(
                "invalid board prefix %r; use MOEX board codes (e.g. TQBR, "
                'SNDX, CETS, TQOB, RFUD)' % prefix)
        board = prefix.upper()
        sec = rest.strip()
    return {'engine': route['engine'], 'market': route['market'],
            'board': board, 'sec': sec}


def _qs(params):
    return urllib.parse.urlencode(params)


def history_url(engine, market, board, sec, start=None,
                from_=None, till=None):
    """Pure daily-history URL builder (``start=`` pages via history.cursor)."""
    params = {'iss.meta': 'off', 'iss.only': 'history,history.cursor'}
    if from_:
        params['from'] = from_
    if till:
        params['till'] = till
    if start:
        params['start'] = int(start)
    return '%s/history/engines/%s/markets/%s/boards/%s/securities/%s.json?%s' % (
        BASE.rstrip('/'), engine, market, board,
        urllib.parse.quote(sec, safe='-._'), _qs(params))


def candles_url(engine, market, board, sec, interval,
                from_, till, start=None):
    """Pure intraday/weekly/monthly candles URL builder."""
    code = iss_interval(interval)
    params = {'iss.meta': 'off', 'iss.only': 'candles,candles.cursor',
              'from': from_, 'till': till, 'interval': code}
    if start:
        params['start'] = int(start)
    return '%s/engines/%s/markets/%s/boards/%s/securities/%s/candles.json?%s' % (
        BASE, engine, market, board,
        urllib.parse.quote(sec, safe='-._'), _qs(params))


def aggregates_url(sec):
    """Pure aggregates shortcut URL builder (daily bars across boards)."""
    return '%s/securities/%s/aggregates.json?%s' % (
        BASE, urllib.parse.quote(sec, safe='-._'),
        _qs({'iss.meta': 'off'}))


def orderbook_url(engine, market, board, sec):
    """Pure order-book URL builder (subscribers-only upstream)."""
    return '%s/engines/%s/markets/%s/boards/%s/securities/%s/orderbook.json?%s' % (
        BASE, engine, market, board,
        urllib.parse.quote(sec, safe='-._'),
        _qs({'iss.meta': 'off', 'iss.only': 'orderbook'}))


def trades_url(engine, market, board, sec):
    """Pure recent-trades tape URL builder."""
    return '%s/engines/%s/markets/%s/boards/%s/securities/%s/trades.json?%s' % (
        BASE, engine, market, board,
        urllib.parse.quote(sec, safe='-._'),
        _qs({'iss.meta': 'off', 'iss.only': 'trades'}))


def search_url(query):
    """Pure securities-search URL builder."""
    return '%s/securities.json?%s' % (
        BASE, _qs({'q': query, 'iss.meta': 'off', 'iss.only': 'securities'}))


def _table(payload, block):
    """Decode an ISS column/data block to [dict]; None when block absent."""
    if not isinstance(payload, dict):
        raise Exception('parse error: not an ISS payload')
    node = payload.get(block)
    if node is None:
        return None
    if not isinstance(node, dict):
        raise Exception('parse error: block %r is not a table' % block)
    columns = node.get('columns') or []
    rows = node.get('data') or []
    cols = [str(c).lower() for c in columns]
    return [dict(zip(cols, r)) for r in rows if isinstance(r, (list, tuple))]


def _num(value):
    if value is None or value == '':
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_moment(value):
    """Parse an ISS date/datetime string to UTC epoch ms."""
    s = str(value).strip()
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
        try:
            dt = datetime.strptime(s[:19] if fmt[0] == '%' and 'H' in fmt else s[:10], fmt)
            return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError('unparseable moment %r' % value)


def _bars_from_rows(rows, date_keys, ohlc_keys, vol_keys, sec):
    bars = []
    for row in rows:
        moment = None
        for key in date_keys:
            if row.get(key) not in (None, ''):
                try:
                    moment = _parse_moment(row[key])
                except ValueError:
                    moment = None
                break
        o = _num(row.get(ohlc_keys[0]))
        c = _num(row.get(ohlc_keys[1]))
        h = _num(row.get(ohlc_keys[2]))
        lo = _num(row.get(ohlc_keys[3]))
        if moment is None or o is None or c is None or h is None or lo is None:
            continue
        v = 0.0
        for key in vol_keys:
            nv = _num(row.get(key))
            if nv is not None:
                v = nv
                break
        bars.append({'t': moment, 'o': o, 'h': h, 'l': lo, 'c': c, 'v': v})
    bars.sort(key=lambda b: b['t'])
    return bars


def parse_history(payload, sec='?'):
    """Decode a history-block payload to ascending [{t,o,h,l,c,v}].

    ``t`` is the TRADEDATE at UTC midnight; rows missing any OHLC leg are
    skipped, missing volume becomes 0.
    """
    rows = _table(payload, 'history')
    if rows is None:
        raise Exception('parse error: no history block for %s' % sec)
    return _bars_from_rows(rows, ('tradedate', 'date', 'begin'),
                           ('open', 'close', 'high', 'low'), ('volume',), sec)


def parse_candles(payload, sec='?'):
    """Decode a candles-block payload to ascending [{t,o,h,l,c,v}].

    ``t`` is the candle ``begin`` instant; rows missing any OHLC leg are
    skipped, missing volume becomes 0.
    """
    rows = _table(payload, 'candles')
    if rows is None:
        raise Exception('parse error: no candles block for %s' % sec)
    return _bars_from_rows(rows, ('begin', 'tradedate', 'date'),
                           ('open', 'close', 'high', 'low'), ('volume',), sec)


def parse_aggregates(payload, sec='?'):
    """Decode an aggregates payload to ascending [{t,o,h,l,c,v}]."""
    rows = _table(payload, 'aggregates')
    if rows is None:
        raise Exception('parse error: no aggregates block for %s' % sec)
    return _bars_from_rows(rows, ('date', 'tradedate', 'begin'),
                           ('open', 'close', 'high', 'low'), ('volume',), sec)


def cursor_state(payload, block):
    """Read an ISS ``*.cursor`` block; None when absent/empty."""
    rows = _table(payload, block)
    if not rows:
        return None
    row = rows[0]
    try:
        total = int(row.get('total'))
        pagesize = int(row.get('pagesize'))
        index = int(row.get('index'))
    except (TypeError, ValueError):
        return None
    return {'total': total, 'pagesize': pagesize, 'index': index}


def merge_bars(pages):
    """Merge page bar-lists: dedupe by ``t`` (last wins), ascending."""
    by_t = {}
    for page in pages:
        for bar in page or []:
            by_t[bar['t']] = bar
    return [by_t[t] for t in sorted(by_t)]


def parse_orderbook(payload, sec='?'):
    """Decode an orderbook payload to {bids, asks} ([[price, qty]]).

    Raises an honest degraded error (never a faked book) when the block is
    missing or empty — the feed is officially subscribers-only.
    """
    rows = _table(payload, 'orderbook')
    if not rows:
        raise Exception(
            'orderbook unavailable for %s (subscribers-only feed; '
            'degraded, no fallback)' % sec)
    bids, asks = [], []
    for row in rows:
        side = str(row.get('buysell') or '').upper()
        price = _num(row.get('price'))
        qty = _num(row.get('quantity'))
        if price is None or qty is None:
            continue
        if side in _BID_MARKS:
            bids.append([price, qty])
        elif side in _ASK_MARKS:
            asks.append([price, qty])
    if not bids and not asks:
        raise Exception(
            'orderbook unavailable for %s (subscribers-only feed; '
            'degraded, no fallback)' % sec)
    bids.sort(key=lambda e: -e[0])
    asks.sort(key=lambda e: e[0])
    return {'bids': bids, 'asks': asks}


def parse_trades(payload, sec='?'):
    """Decode a trades-tape payload to ascending [{t, price, qty}]."""
    rows = _table(payload, 'trades')
    if rows is None:
        raise Exception('parse error: no trades block for %s' % sec)
    out = []
    for row in rows:
        moment = None
        for key in ('tradetime', 'time', 'moment'):
            if row.get(key) not in (None, ''):
                try:
                    moment = _parse_moment(row[key])
                except ValueError:
                    moment = None
                break
        price = _num(row.get('price'))
        qty = _num(row.get('quantity'))
        if qty is None:
            qty = _num(row.get('volume'))
        if moment is None or price is None or qty is None:
            continue
        out.append({'t': moment, 'price': price, 'qty': qty})
    out.sort(key=lambda e: e['t'])
    return out


def parse_search(payload):
    """Decode a securities-search payload to [{symbol, name}] (top 10)."""
    rows = _table(payload, 'securities')
    if rows is None:
        raise Exception('parse error: not an ISS securities payload')
    out = []
    for row in rows:
        secid = row.get('secid')
        if not secid:
            continue
        name = (row.get('shortname') or row.get('secname')
                or row.get('name') or str(secid))
        out.append({'symbol': str(secid), 'name': str(name)})
        if len(out) >= 10:
            break
    return out


# --------------------------------------------------------------- transport ---

def _pace():
    """Enforce >= _MIN_GAP between live requests (<=4 req/s)."""
    now = time.monotonic()
    wait = _MIN_GAP - (now - _LAST_TS[0])
    if wait > 0:
        time.sleep(wait)
        now = time.monotonic()
    _LAST_TS[0] = now


def _get_json(url, timeout=_HTTP_TIMEOUT):
    """GET a URL and decode its JSON body; 429 maps to the rate-limit error."""
    _pace()
    request = urllib.request.Request(
        url, headers={'User-Agent': _UA, 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode('utf-8')
    except HTTPError as exc:
        if exc.code == 429:
            raise Exception('rate limited (429), retry shortly')
        raise Exception('upstream HTTP %s: %s' % (exc.code, exc.reason))
    except URLError as exc:
        raise Exception('network error: %s' % exc.reason)
    except (TimeoutError, OSError) as exc:
        raise Exception('network error: %s' % exc)
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise Exception('parse error: invalid JSON (%s)' % exc)


def _fetch(url, _fetcher):
    return _fetcher(url) if _fetcher else _get_json(url)


def _fmt_ts(ms):
    return datetime.fromtimestamp(
        ms / 1000.0, tz=timezone.utc).strftime('%Y-%m-%d %H:%M:%S')


def _fmt_date(ms):
    return datetime.fromtimestamp(
        ms / 1000.0, tz=timezone.utc).strftime('%Y-%m-%d')


def _page_loop(url_fn, parse_fn, cursor_block, sec, _fetcher,
               max_pages=25):
    """Walk ISS ``start=`` pages to exhaustion; return merged ascending bars.

    Pages arrive oldest-first, so callers bound the window with from/till
    and trim the merged tail — stopping early on a count would keep the
    oldest bars instead of the latest.
    """
    pages = []
    start = 0
    for _ in range(max_pages):
        payload = _fetch(url_fn(start if start else None), _fetcher)
        pages.append(parse_fn(payload, sec))
        cur = cursor_state(payload, cursor_block)
        if cur is None:
            break
        if cur['index'] + cur['pagesize'] >= cur['total']:
            break
        if not pages[-1]:
            break
        start = cur['index'] + cur['pagesize']
    return merge_bars(pages)


# ---------------------------------------------------------------- contract ---

def candles(venue, symbol, interval, limit=300, _fetcher=None):
    """Fetch ascending [{t(ms),o,h,l,c,v}] for (venue, symbol, interval).

    Daily bars come from the history leg (``start=`` paged, merged on
    ``history.cursor``) with the aggregates shortcut as same-secid
    fallback; every other interval uses the candles leg with the ISS
    interval code. ``_fetcher`` is a test seam (callable url -> decoded
    JSON); the companion server calls with the four public arguments only.
    """
    iss_interval(interval)  # validates against INTERVALS first
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise Exception('invalid limit %r; expected 1..1000' % (limit,))
    limit = max(1, min(1000, limit))
    route = resolve(venue, symbol)
    engine, market, board, sec = (route['engine'], route['market'],
                                 route['board'], route['sec'])
    till_ms = int(time.time() * 1000)
    if interval == '1d':
        # ~250 trading days/yr: 1.6x + 10d pad covers weekends/holidays.
        from_ms = till_ms - (int(limit * 1.6) + 10) * 86400000
        bars = _page_loop(
            lambda start: history_url(engine, market, board, sec,
                                      start=start,
                                      from_=_fmt_date(from_ms),
                                      till=_fmt_date(till_ms)),
            parse_history, 'history.cursor', sec, _fetcher)
        if not bars:
            agg = _fetch(aggregates_url(sec), _fetcher)
            bars = sorted(parse_aggregates(agg, sec),
                          key=lambda b: b['t'])
        if not bars:
            raise Exception(
                'history unavailable for %s (unknown/delisted symbol or '
                'empty upstream range)' % sec)
        return bars[-limit:]
    span = _INTERVAL_SECS[interval] * limit
    from_ms = till_ms - (span * 2 + 86400) * 1000
    bars = _page_loop(
        lambda start: candles_url(engine, market, board, sec, interval,
                                  _fmt_ts(from_ms), _fmt_ts(till_ms),
                                  start=start),
        parse_candles, 'candles.cursor', sec, _fetcher)
    if not bars:
        raise Exception(
            'history unavailable for %s (unknown/delisted symbol or '
            'empty upstream range)' % sec)
    return bars[-limit:]


def search(venue, query, _fetcher=None):
    """Securities lookup via /securities.json?q=; returns [{symbol, name}]."""
    if venue and venue not in _VENUE_IDS:
        raise Exception(
            'unknown venue %r; expected one of: %s'
            % (venue, ', '.join(sorted(_VENUE_IDS))))
    q = (query or '').strip()
    if not q:
        raise Exception('empty search query')
    if len(q) > 64:
        raise Exception('search query too long (max 64 chars)')
    payload = _fetch(search_url(q), _fetcher)
    return parse_search(payload)


def quote(venue, symbol, _fetcher=None):
    """Last daily close + prev close + change% from 2 history bars."""
    route = resolve(venue, symbol)
    till_ms = int(time.time() * 1000)
    from_ms = till_ms - 30 * 86400000
    bars = _page_loop(
        lambda start: history_url(route['engine'], route['market'],
                                  route['board'], route['sec'], start=start,
                                  from_=_fmt_date(from_ms),
                                  till=_fmt_date(till_ms)),
        parse_history, 'history.cursor', route['sec'], _fetcher)
    if len(bars) < 2:
        raise Exception(
            'not enough data for quote %s: need 2 daily bars, got %d'
            % (route['sec'], len(bars)))
    prev, last = bars[-2]['c'], bars[-1]['c']
    change = ((last - prev) / prev * 100.0) if prev else 0.0
    return {'symbol': (symbol or '').strip(), 'venue': venue,
            'price': last, 'prev_close': prev,
            'change_pct': change, 't': bars[-1]['t']}


def depth(venue, symbol, limit=20, _fetcher=None):
    """Order-book snapshot; raises honest degraded on denied/empty feeds."""
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise Exception('invalid limit %r; expected 1..100' % (limit,))
    limit = max(1, min(100, limit))
    route = resolve(venue, symbol)
    try:
        payload = _fetch(orderbook_url(route['engine'], route['market'],
                                       route['board'], route['sec']), _fetcher)
        book = parse_orderbook(payload, route['sec'])
    except Exception as exc:
        if 'subscribers-only' in str(exc):
            raise
        raise Exception(
            'orderbook unavailable for %s (subscribers-only feed; '
            'degraded, no fallback): %s' % (route['sec'], exc))
    return {'symbol': (symbol or '').strip(), 'venue': venue,
            'bids': book['bids'][:limit], 'asks': book['asks'][:limit]}


def trades(venue, symbol, limit=100, _fetcher=None):
    """Recent tape via trades.json (extra helper; newest last)."""
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise Exception('invalid limit %r; expected 1..500' % (limit,))
    limit = max(1, min(500, limit))
    route = resolve(venue, symbol)
    payload = _fetch(trades_url(route['engine'], route['market'],
                                route['board'], route['sec']), _fetcher)
    return parse_trades(payload, route['sec'])[-limit:]

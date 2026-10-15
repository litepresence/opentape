"""Yahoo Finance source for the Opentape companion (workstream C).

Covers stocks & indices worldwide via Yahoo's keyless ``v8/finance/chart``
route (raw ``urllib``; no crumb handling needed for the chart route, no
``yfinance`` import) plus ``v1/finance/search`` for symbol lookup.

Live-only honesty: every fetch raises ``Exception(detail)`` on failure and
never substitutes another symbol — except the contracted NSE ``.NS`` → ``.BO``
fallback, which is the same issuer on its alternate domestic listing.

Suffix notes (verified 2026-10-14): Tadawul is ``.SAU`` (NOT ``.SR``) with a
dedicated ``Tadawul`` venue; Madrid/BME is ``.MC`` (NOT ``.ES``) with a
dedicated ``BME`` venue. Stale ``.SR`` / ``.ES`` tickers raise with a
redirect note instead of fetching empty data. Egypt ``.CA`` is index-only —
equity-looking ``.CA`` symbols raise ('EGX single names unsupported').
Hanoi HNX and Beijing BSE have no Yahoo suffix and raise as unsupported
(Beijing names point at source ``china`` with its ``bj.`` prefix).
Parseable-but-empty responses (typical for venture/GEM thin names such as
``.V`` / ``.CN`` / ``.NE`` / HK GEM / ASX / B3 smallcaps, or delisted
tickers) raise 'no data yet for this listing', distinct from the
network/upstream error-retry path. China A ``.SS`` / ``.SZ`` tickers remain
reachable here but are a last-resort fallback — the primary China pipeline
lives in source ``china`` (see STREAM note).
"""

import json
import re
import time
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError

SOURCE = 'yahoo'
LABEL = 'Stocks & Indices'
INTERVALS = ['1m', '2m', '5m', '15m', '30m', '1h',
             '1d', '5d', '1wk', '1mo', '3mo']
STREAM = {'mode': 'poll', 'cadence': 60,
          'note': ('intraday \u226460d; daily decades; '
                   'China .SS/.SZ fallback-only (primary: source china)')}

HOSTS = ('query1.finance.yahoo.com', 'query2.finance.yahoo.com')
_HTTP_TIMEOUT = 15

_UAS = [
    ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
     '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'),
    ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
     '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'),
    ('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) '
     'Gecko/20100101 Firefox/128.0'),
]

_VENUES = [
    {'id': 'US', 'label': 'US Stocks'},
    {'id': 'NSE', 'label': 'India NSE'},
    {'id': 'BSE', 'label': 'India BSE'},
    {'id': 'LSE', 'label': 'London'},
    {'id': 'TSE', 'label': 'Tokyo'},
    {'id': 'TSX', 'label': 'Toronto'},
    {'id': 'ASX', 'label': 'Australia'},
    {'id': 'B3', 'label': 'Brazil B3'},
    {'id': 'HKEX', 'label': 'Hong Kong'},
    {'id': 'Euronext', 'label': 'Euronext'},
    {'id': 'Tadawul', 'label': 'Saudi Tadawul'},
    {'id': 'BME', 'label': 'Spain BME'},
    {'id': 'FX', 'label': 'FX'},
    {'id': 'Commodities', 'label': 'Commodities'},
    {'id': 'Rates', 'label': 'Rates & Yields'},
    {'id': 'Indices', 'label': 'Indices'},
]
_VENUE_IDS = frozenset(v['id'] for v in _VENUES)

_EQUITY_SUFFIX = {
    'NSE': '.NS', 'BSE': '.BO', 'LSE': '.L', 'TSE': '.T',
    'TSX': '.TO', 'ASX': '.AX', 'B3': '.SA',
    'Tadawul': '.SAU', 'BME': '.MC',
}
_EURONEXT_SUFFIXES = ('.PA', '.AS', '.BR', '.LS')
_EURONEXT_PREFIX = {
    'PA': '.PA', 'EPA': '.PA', 'XPAR': '.PA',
    'AS': '.AS', 'XAMS': '.AS',
    'BR': '.BR', 'XBRU': '.BR',
    'LS': '.LS', 'XLIS': '.LS',
}

_SYM_RE = re.compile(r'^[A-Za-z0-9.\-=^:/]{1,64}$')

# Stale/wrong-market suffix guards (verified 2026-10-14). Checked in
# build_ticker() before any venue dispatch so every venue (including the
# verbatim US passthrough) fails loudly instead of charting empty data.
_STALE_SUFFIX_REDIRECT = {
    '.SR': ("stale suffix '.SR' for Saudi Tadawul; use '.SAU' "
            "(e.g. '2222.SAU') via venue Tadawul"),
    '.ES': ("stale suffix '.ES' for Madrid/BME; use '.MC' "
            "(e.g. 'SAN.MC') via venue BME"),
}
_EGX_UNSUPPORTED = (
    'EGX single names unsupported: Yahoo .CA is index-only '
    '(single-name EGX history unavailable; EGX indices via the Indices venue)'
)
_HNX_UNSUPPORTED = (
    'Hanoi HNX unsupported on Yahoo (no Yahoo suffix; history unavailable)'
)
_BEIJING_UNSUPPORTED = (
    'Beijing BSE unsupported on Yahoo (no Yahoo suffix; '
    'use source china with its bj. prefix, e.g. bj.430047)'
)

# B3 note (verified 2026-10-14): Yahoo intraday for '.SA' names truncates
# around ~16:55 local (the closing auction prints separately), so the last
# intraday bar can look cut off. Intervals pass straight through to Yahoo —
# no resampling or padding here — so no code change is needed for it.
_INTERVAL_SECS = {
    '1m': 60, '2m': 120, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600,
    '1d': 86400, '5d': 5 * 86400, '1wk': 7 * 86400,
    '1mo': 30 * 86400, '3mo': 90 * 86400,
}
_DAY = 86400
_RANGE_STEPS = (  # (range label, span covered in seconds)
    ('1d', _DAY), ('5d', 5 * _DAY), ('1mo', 30 * _DAY),
    ('3mo', 90 * _DAY), ('6mo', 180 * _DAY), ('1y', 365 * _DAY),
    ('2y', 2 * 365 * _DAY), ('5y', 5 * 365 * _DAY),
    ('10y', 10 * 365 * _DAY), ('max', float('inf')),
)


# ---------------------------------------------------------------- venues ---

def venues():
    """Return [{id, label}] for the 16 venues."""
    return [dict(v) for v in _VENUES]


# ------------------------------------------------------------- pure helpers ---

def _pick_ua(key=None):
    """Rotate across the browser UA pool (time-based by default)."""
    if key is None:
        key = int(time.time())
    return _UAS[key % len(_UAS)]


def _euronext_ticker(symbol):
    up = symbol.strip().upper()
    for suffix in _EURONEXT_SUFFIXES:
        if up.endswith(suffix):
            return up
    if ':' in up:
        prefix, rest = up.split(':', 1)
        rest = rest.strip()
        if prefix not in _EURONEXT_PREFIX:
            raise Exception(
                "unknown Euronext exchange prefix %r; use PA/AS/BR/LS "
                "(e.g. 'PA:AI')" % prefix)
        if not rest:
            raise Exception('empty symbol after Euronext prefix')
        return rest + _EURONEXT_PREFIX[prefix]
    if up.startswith('^') or '=' in up or '.' in up:
        return up  # already-qualified ticker (e.g. Madrid '.MC'): verbatim
    return up + '.PA'  # default: Paris (largest Euronext market)


def build_ticker(venue, symbol):
    """Map (venue, user symbol) to a Yahoo ticker; never guesses exchanges."""
    if venue not in _VENUE_IDS:
        raise Exception(
            "unknown venue %r; expected one of: %s"
            % (venue, ', '.join(sorted(_VENUE_IDS))))
    s = (symbol or '').strip()
    if not s:
        raise Exception('empty symbol')
    if not _SYM_RE.match(s):
        raise Exception(
            "invalid symbol %r; use Yahoo-style tickers (letters, digits, "
            "'.-=/^:')" % s)
    up = s.upper()
    # Stale-suffix redirect notes (verified 2026-10-14): fail loudly so a
    # mistyped suffix never charts empty data.
    for _stale, _note in _STALE_SUFFIX_REDIRECT.items():
        if up.endswith(_stale):
            raise Exception('%s (got %r)' % (_note, s))
    # Egypt .CA is index-only: single names have no Yahoo history.
    if up.endswith('.CA'):
        raise Exception('%s (got %r)' % (_EGX_UNSUPPORTED, s))
    # Hanoi HNX / Beijing BSE have no Yahoo suffix: never silent empty.
    if up.endswith('.HN') or up.endswith('.HNX') or up.startswith('HNX:'):
        raise Exception('%s (got %r)' % (_HNX_UNSUPPORTED, s))
    if up.endswith('.BJ') or up.startswith('BJ.'):
        raise Exception('%s (got %r)' % (_BEIJING_UNSUPPORTED, s))
    if venue == 'US':
        return s
    if venue == 'FX':
        base = s.upper().replace('/', '').replace('-', '')
        if base.endswith('=X'):
            return base
        return base + '=X'
    if venue in ('Commodities', 'Rates', 'Indices'):
        return s.upper()  # 'GC=F', 'EURUSD=X', '^TNX' used verbatim
    if venue == 'HKEX':
        up = s.upper()
        if up.endswith('.HK'):
            return up
        core = up
        if core.isdigit():
            core = core.zfill(4)
        return core + '.HK'
    if venue == 'Euronext':
        return _euronext_ticker(s)
    suffix = _EQUITY_SUFFIX[venue]
    up = s.upper()
    if up.endswith(suffix):
        return up
    if up.startswith('^') or '=' in up or '.' in up:
        return s  # explicitly qualified cross-listing: leave it alone
    return up + suffix


def interval_seconds(interval):
    """Bar length in seconds; raises on intervals outside INTERVALS."""
    try:
        return _INTERVAL_SECS[interval]
    except KeyError:
        raise Exception(
            "unsupported interval %r; supported: %s"
            % (interval, ', '.join(INTERVALS)))


def pick_range(interval, limit):
    """Smallest Yahoo range covering limit bars; intraday capped at 3mo."""
    span = interval_seconds(interval) * max(1, int(limit))
    for label, covered in _RANGE_STEPS:
        if covered >= span:
            picked = label
            break
    else:
        picked = 'max'
    if _INTERVAL_SECS[interval] < _DAY:
        cap = [label for label, _ in _RANGE_STEPS].index('3mo')
        order = [label for label, _ in _RANGE_STEPS]
        if order.index(picked) > cap:
            picked = '3mo'
    return picked


def chart_url(host, ticker, interval, range_):
    """Pure v8/chart URL builder (query1 tried first, query2 on failure)."""
    q = urllib.parse.urlencode({'interval': interval, 'range': range_})
    return ('https://%s/v8/finance/chart/%s?%s'
            % (host, urllib.parse.quote(ticker, safe=''), q))


def search_url(host, query):
    """Pure v1/finance/search URL builder (top-8 quotes, no news)."""
    q = urllib.parse.urlencode(
        {'q': query, 'quotesCount': 8, 'newsCount': 0, 'lang': 'en'})
    return 'https://%s/v1/finance/search?%s' % (host, q)


def parse_chart(payload):
    """Decode a v8/chart JSON payload to ascending adjusted bars.

    Applies split/dividend adjustment auto_adjust-style (each bar's
    OHLC scaled by that bar's adjclose/close ratio); rows with missing
    OHLC are skipped, missing volume becomes 0. Returns [] when the
    payload carries no usable bars; raises on upstream error objects.
    """
    try:
        chart = payload['chart']
    except (TypeError, KeyError):
        raise Exception('parse error: not a Yahoo chart payload')
    if not isinstance(chart, dict):
        raise Exception('parse error: not a Yahoo chart payload')
    if chart.get('error'):
        err = chart['error']
        detail = err.get('description') or err.get('code') or err
        raise Exception('upstream error: %s' % detail)
    results = chart.get('result') or []
    if not results:
        raise Exception('empty response: no result (unknown symbol?)')
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
        lo = lows[i] if i < len(lows) else None
        c = closes[i] if i < len(closes) else None
        if o is None or h is None or lo is None or c is None:
            continue
        a = adj[i] if i < len(adj) else None
        factor = (a / c) if (a and c) else 1.0
        v = vols[i] if i < len(vols) and vols[i] is not None else 0
        bars.append({
            't': int(stamp) * 1000,
            'o': float(o) * factor,
            'h': float(h) * factor,
            'l': float(lo) * factor,
            'c': float(c) * factor,
            'v': float(v),
        })
    bars.sort(key=lambda b: b['t'])
    return bars


def parse_search(payload):
    """Decode a v1/finance/search payload to [{symbol, name}] (top 8)."""
    try:
        quotes = payload['quotes']
    except (TypeError, KeyError):
        raise Exception('parse error: not a Yahoo search payload')
    rows = []
    for entry in (quotes or [])[:8]:
        if not isinstance(entry, dict) or not entry.get('symbol'):
            continue
        rows.append({
            'symbol': entry['symbol'],
            'name': (entry.get('shortname') or entry.get('longname')
                     or entry['symbol']),
        })
    return rows


# --------------------------------------------------------------- transport ---

def _get_json(url, timeout=_HTTP_TIMEOUT):
    """GET a URL and decode its JSON body; 429 maps to the rate-limit error."""
    request = urllib.request.Request(
        url, headers={'User-Agent': _pick_ua(),
                      'Accept': 'application/json'})
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


def _try_hosts(ticker, interval, range_, _fetcher=None):
    """Fetch+parse across query1/query2; returns (bars, error-or-None)."""
    last_error = None
    for host in HOSTS:
        url = chart_url(host, ticker, interval, range_)
        try:
            payload = _fetcher(url) if _fetcher else _get_json(url)
            bars = parse_chart(payload)
        except Exception as exc:  # noqa: BLE001 - surfaced as data below
            last_error = exc
            continue
        if bars:
            return bars, None
        # Valid-ticker-but-empty (delisted names, venture/GEM thin listings
        # such as .V/.CN/.NE/HK-GEM/ASX/B3 smallcaps): a calm 'no data yet'
        # state, deliberately distinct from the network/upstream error-retry
        # path above (whose messages never contain 'no data yet').
        last_error = Exception(
            'empty response for %s (%s/%s): no data yet for this listing '
            '(Yahoo returned no candles; thin venture/GEM/smallcap names '
            'often list before history appears, delisted names stay empty)'
            % (ticker, interval, range_))
    return [], last_error


def _load_bars(venue, ticker, interval, range_, _fetcher=None):
    """Primary fetch plus the contracted NSE .NS -> .BO fallback."""
    bars, error = _try_hosts(ticker, interval, range_, _fetcher)
    used = ticker
    if (not bars and venue == 'NSE'
            and ticker.upper().endswith('.NS')
            and not (error and 'rate limited (429)' in str(error))):
        alt = ticker.upper()[:-len('.NS')] + '.BO'
        alt_bars, alt_error = _try_hosts(alt, interval, range_, _fetcher)
        if alt_bars:
            return alt_bars, alt
        error = alt_error or error
    if not bars:
        raise error or Exception('empty response for %s' % ticker)
    return bars, used


# ---------------------------------------------------------------- contract ---

def candles(venue, symbol, interval, limit=300, _fetcher=None):
    """Fetch ascending [{t(ms),o,h,l,c,v}] for (venue, symbol, interval).

    ``_fetcher`` is a test seam (callable url -> decoded JSON); the
    companion server calls with the four public arguments only.
    Valid-ticker-but-empty raises 'no data yet for this listing' (thin /
    delisted names); transport and upstream failures keep their retryable
    error text.
    """
    interval_seconds(interval)  # validates against INTERVALS first
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise Exception('invalid limit %r; expected 1..1000' % (limit,))
    limit = max(1, min(1000, limit))
    ticker = build_ticker(venue, symbol)
    bars, _used = _load_bars(venue, ticker, interval,
                             pick_range(interval, limit), _fetcher)
    return bars[-limit:]


def search(venue, query, _fetcher=None):
    """Symbol lookup; returns [{symbol, name}] (top 8)."""
    if venue not in _VENUE_IDS:
        raise Exception(
            "unknown venue %r; expected one of: %s"
            % (venue, ', '.join(sorted(_VENUE_IDS))))
    q = (query or '').strip()
    if not q:
        raise Exception('empty search query')
    if len(q) > 64:
        raise Exception('search query too long (max 64 chars)')
    last_error = None
    for host in HOSTS:
        url = search_url(host, q)
        try:
            payload = _fetcher(url) if _fetcher else _get_json(url)
            return parse_search(payload)
        except Exception as exc:  # noqa: BLE001 - retried, then surfaced
            last_error = exc
    raise last_error or Exception('search failed for %r' % q)


def quote(venue, symbol, _fetcher=None):
    """Last close + prev close + change% from 2 daily bars (cheap)."""
    ticker = build_ticker(venue, symbol)
    bars, used = _load_bars(venue, ticker, '1d', '5d', _fetcher)
    if len(bars) < 2:
        raise Exception(
            'not enough data for quote %s: need 2 daily bars, got %d'
            % (used, len(bars)))
    prev, last = bars[-2]['c'], bars[-1]['c']
    change = ((last - prev) / prev * 100.0) if prev else 0.0
    return {
        'symbol': (symbol or '').strip(),
        'ticker': used,
        'price': last,
        'prev_close': prev,
        'change_pct': change,
        't': bars[-1]['t'],
    }

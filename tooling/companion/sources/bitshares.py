"""BitShares DEX companion source (workstream F).

Live market data for the BitShares Graphene DEX over public WebSocket
full-node APIs, plus an Elasticsearch (ES) path for AMM pool history.

Contract (verbatim, see docs/superpowers/plans/2026-10-14-opentape-suite.md)::

    SOURCE = 'bitshares'
    LABEL = 'BitShares DEX'
    INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']
    STREAM = {'mode': 'poll', 'cadence': 15, ...}

    def venues() -> [{'id', 'label'}]
    def candles(venue, symbol, interval, limit=300) -> [{t,o,h,l,c,v}] asc
    def search(venue, query) -> [{symbol, name}]

Optional: ``quote(venue, symbol)`` / ``depth(venue, symbol, limit)``.

Symbol form is ``BASE:QUOTE`` (e.g. ``BTS:bitUSD``), i.e. the price of one
unit of BASE denominated in QUOTE. Candle ``v`` is base-asset volume in
BASE units.

Transport
---------
* Node RPC: the ``websocket-client`` pip package (``import websocket``).
  It is OPTIONAL: when absent the module still imports, all pure-math
  helpers stay testable, and :func:`status` reports
  ``{'ok': False, 'reason': <install hint>}`` so the companion server can
  mark this source degraded instead of crashing. Live functions
  (:func:`candles`, :func:`orderbook`, :func:`quote`, :func:`feeds`,
  :func:`search`, ES paging) raise ``Exception`` with the install hint.
* ES path: stdlib ``urllib`` POST only (no extra dependency).

Pair-orientation rule (read carefully)
--------------------------------------
BitShares market APIs take two asset ids and the price semantics depend on
their order. Canonical API order is **ascending numeric asset id**: for ids
``1.3.N`` / ``1.3.M`` the asset with the smaller number sorts first.
:func:`orient_pair` implements exactly this and returns a ``flipped`` flag
whenever the requested BASE ends up second. Callers convert prices back to
the requested ``BASE:QUOTE`` orientation explicitly (inverting when
``flipped``). We **never invert silently**: the flag is always computed,
documented, and applied in one visible step inside each live function, and
every value this module returns is denominated in the requested
``BASE:QUOTE`` orientation (price = QUOTE per 1 BASE).

Satoshi-string handling
-----------------------
Graphene nodes serialise asset amounts as **integer satoshis** — the
smallest indivisible unit — and JSON may carry them either as numbers or as
decimal strings (e.g. ``12345`` or ``"12345"`` for 0.12345 BTS at precision
5). :func:`amount_to_float` coerces ``int`` / ``float`` / numeric-``str``
via ``int(str)`` first (never ``float(str)`` directly, which would admit
fractional satoshis) and divides by ``10 ** precision``. Order-book entries
(``base``/``quote`` fields of bids/asks) go through the same converter, so
string and numeric wire forms produce identical floats.

No GPL code is imported here (stdlib + optional ``websocket-client`` only).
"""

import json
import socket
import time
import urllib.request
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Identity / capabilities
# ---------------------------------------------------------------------------

SOURCE = 'bitshares'
LABEL = 'BitShares DEX'
INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']
STREAM = {
    'mode': 'poll',
    'cadence': 15,
    'note': 'poll ~15s; node history API has no push feed, ES path is paging',
}

INSTALL_HINT = 'pip install websocket-client  (BitShares source needs it for node WS RPC)'

try:  # optional transport — absence must degrade, never crash the import
    import websocket as _ws  # type: ignore
    WS_AVAILABLE = True
except Exception:  # ImportError or anything stranger on exotic platforms
    _ws = None
    WS_AVAILABLE = False


def status():
    """Availability probe for the companion server registry.

    Returns ``{'ok': True}`` when the WS transport is importable, else
    ``{'ok': False, 'reason': <install hint>}``. Pure-math helpers remain
    usable either way.
    """
    if WS_AVAILABLE:
        return {'ok': True}
    return {'ok': False, 'reason': INSTALL_HINT}


STATUS = {'ok': WS_AVAILABLE, 'reason': None if WS_AVAILABLE else INSTALL_HINT}

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BUCKET_SECONDS = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '4h': 14400,
    '1d': 86400,
}

#: Native ``get_market_history`` returns at most this many buckets per call.
HISTORY_PAGE_SLOTS = 200

#: Native trade-history row cap the ES path exists to page beyond.
NATIVE_TRADE_HISTORY_CAP = 101

#: ES paging budget: at most 8 pages of 10k hits.
ES_MAX_PAGES = 8
ES_PAGE_SIZE = 10000
ES_URL = 'https://es.bitshares.dev/bitshares-*/_search'

#: BitShares operation types of interest on ES: 63 = liquidity-pool
#: exchange (AMM pool swap). NOTE: op-4 (fill_order, classic limit-order
#: fills) is a *separate* query/filter — never chart op-63 swaps and op-4
#: fills as one series without labelling which is which.
ES_OP_POOL_SWAP = 63
ES_OP_FILL = 4

#: XBTS REST daily klines are a documented fallback for order-book-adjacent
#: daily history when both the node history plugin and ES are unreachable.
#: Not implemented here (different host/auth envelope); recorded so callers
#: know where to go next instead of inventing a third path.
XBTS_REST_NOTE = (
    'fallback: XBTS REST daily klines (api.xbts.io) — documented only, '
    'not implemented in this module'
)

WS_HANDSHAKE_TIMEOUT = 5  # seconds, per workstream spec

SEED_NODES = [
    'wss://api.bts.mobi/ws',
    'wss://eu.nodes.bitshares.ws/ws',
    'wss://dex.iobanker.com/ws',
    'wss://node.xbts.io/ws',
    'wss://public.xbts.io/ws',
    'wss://btsws.roelandp.nl/ws',
]

#: bitshares-signing-style fallback endpoints (extra public full nodes in
#: the same URL shape the BitShares signing helpers ship). Tried only after
#: every seed node fails or lacks the history plugin.
FALLBACK_NODES = [
    'wss://api.bitshares.ws/ws',
    'wss://bts-api.lafona.net/ws',
]

#: Default feed lifetime: BitShares price feeds expire ~24h after
#: publication (``feed_lifetime_sec`` = 86400 on most bitassets).
FEED_LIFETIME_S = 86400

#: (symbol upper-case) -> (asset_id, precision). Populated by live
#: resolution; pre-seedable in tests/air-gapped use.
PRECISION_CACHE = {}

VENUE_ID = 'bitshares'


# ---------------------------------------------------------------------------
# Pure helpers: intervals / time
# ---------------------------------------------------------------------------

def validate_interval(interval):
    """Return bucket seconds for *interval* or raise with supported list."""
    if interval in BUCKET_SECONDS:
        return BUCKET_SECONDS[interval]
    raise ValueError(
        'unsupported interval %r for source %r; supported: %s'
        % (interval, SOURCE, sorted(BUCKET_SECONDS, key=BUCKET_SECONDS.get))
    )


def bucket_seconds(interval):
    """Bucket length in seconds (validates first)."""
    return validate_interval(interval)


def bucket_start_ms(ts_ms, bucket_s):
    """Floor a millisecond timestamp to its bucket open."""
    return (int(ts_ms) // (int(bucket_s) * 1000)) * int(bucket_s) * 1000


def to_bitshares_time(ts_ms):
    """Format ms epoch as BitShares ISO (``YYYY-MM-DDTHH:MM:SS``, UTC)."""
    return datetime.fromtimestamp(int(ts_ms) / 1000, tz=timezone.utc).strftime(
        '%Y-%m-%dT%H:%M:%S'
    )


def parse_bitshares_time(s):
    """Parse BitShares ISO (trailing ``Z`` tolerated) to seconds epoch (UTC)."""
    text = str(s).strip()
    if text.endswith('Z'):
        text = text[:-1]
    dt = datetime.strptime(text[:19], '%Y-%m-%dT%H:%M:%S').replace(
        tzinfo=timezone.utc
    )
    return int(dt.timestamp())


# ---------------------------------------------------------------------------
# Pure helpers: assets / precision / orientation
# ---------------------------------------------------------------------------

def parse_symbol(symbol):
    """Split ``BASE:QUOTE`` into ``(base, quote)`` (upper-cased symbols).

    Raises ``ValueError`` for anything not shaped like ``BASE:QUOTE`` with
    1..32 alphanumerics/dots per side (per-source tightening of the server
    ``^[A-Za-z0-9.\\-=^:/]{1,64}$`` rule).
    """
    parts = str(symbol or '').split(':')
    if len(parts) != 2 or not all(
        p and len(p) <= 32 and all(c.isalnum() or c == '.' for c in p)
        for p in parts
    ):
        raise ValueError(
            'symbol must look like BASE:QUOTE (got %r)' % (symbol,)
        )
    return parts[0].upper(), parts[1].upper()


def parse_asset_num(asset_id):
    """Numeric suffix of a Graphene asset id (``1.3.N`` -> ``N``)."""
    try:
        head, num = str(asset_id).rsplit('.', 1)
        if head != '1.3':
            raise ValueError
        return int(num)
    except (ValueError, AttributeError):
        raise ValueError('malformed asset id %r (want 1.3.N)' % (asset_id,))


def orient_pair(sym_a, id_a, sym_b, id_b):
    """Normalise a pair to canonical API order.

    Rule: ascending numeric asset id first (``1.3.N`` with smaller ``N``
    sorts first). Returns ``{'first_symbol', 'first_id', 'second_symbol',
    'second_id', 'flipped'}`` where ``flipped`` is True iff the requested
    BASE (``sym_a``) ended up second. Consumers MUST apply ``flipped``
    explicitly (price inversion) so output stays in requested
    ``BASE:QUOTE`` orientation — never invert silently.
    """
    na, nb = parse_asset_num(id_a), parse_asset_num(id_b)
    if na == nb:
        raise ValueError('identical assets in pair: %r' % (id_a,))
    if na < nb:
        return {
            'first_symbol': sym_a, 'first_id': id_a,
            'second_symbol': sym_b, 'second_id': id_b,
            'flipped': False,
        }
    return {
        'first_symbol': sym_b, 'first_id': id_b,
        'second_symbol': sym_a, 'second_id': id_a,
        'flipped': True,
    }


def amount_to_float(amount, precision):
    """Convert integer satoshis (int or numeric string) to float units.

    ``amount`` may arrive as a JSON number or as a decimal string — both
    mean whole satoshis. ``precision`` is the asset's decimals, so
    ``amount_to_float("12345", 5) == 0.12345``. Raises ``ValueError`` on
    non-numeric input (fail loudly rather than chart a guess).
    """
    if isinstance(amount, bool):
        raise ValueError('bad amount %r' % (amount,))
    try:
        if isinstance(amount, float):
            if not amount.is_integer():
                raise ValueError
            sat = int(amount)
        else:
            sat = int(str(amount).strip())
    except (ValueError, TypeError, AttributeError):
        raise ValueError('bad amount %r (want integer satoshis)' % (amount,))
    return sat / (10 ** int(precision))


def price_from_pair(base_sat, quote_sat, base_prec, quote_prec):
    """Price of BASE in QUOTE from raw satoshi legs; None when base is 0."""
    base_f = amount_to_float(base_sat, base_prec)
    if base_f == 0:
        return None
    return amount_to_float(quote_sat, quote_prec) / base_f


def clamp_depth_limit(limit):
    """Order-book depth clamp: 1..50 (spec: ``limit<=50``)."""
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = 50
    return max(1, min(50, n))


# ---------------------------------------------------------------------------
# Pure helpers: market-history buckets -> candles
# ---------------------------------------------------------------------------

def chunk_ranges(start_ms, end_ms, bucket_s, max_slots=HISTORY_PAGE_SLOTS):
    """Split ``[start_ms, end_ms)`` into ``(start_iso, end_iso)`` windows of
    at most ``max_slots`` buckets each (native ``get_market_history`` page
    cap). Returns ascending ``[(start_iso, end_iso), ...]``."""
    span_ms = int(bucket_s) * 1000 * int(max_slots)
    out, cur = [], int(start_ms)
    end_ms = int(end_ms)
    if end_ms <= cur:
        raise ValueError('empty time range')
    while cur < end_ms:
        nxt = min(cur + span_ms, end_ms)
        out.append((to_bitshares_time(cur), to_bitshares_time(nxt)))
        cur = nxt
    return out


def _leg(row, name, default=0):
    return row.get(name, default) if isinstance(row, dict) else default


def bucket_row_to_candle(row, base_prec, quote_prec, invert=False):
    """Convert one ``get_market_history`` bucket to ``{t,o,h,l,c,v}``.

    The wire row prices the API-first asset in API-second units; when
    ``invert`` is True (requested BASE sorted second, see
    :func:`orient_pair`) every leg is inverted so the candle stays in
    requested ``BASE:QUOTE`` orientation. ``t`` is the bucket-open ms,
    ``v`` is base-asset volume in BASE units. Returns None for buckets
    with no tradable legs (zero base amounts throughout).
    """
    key = row.get('key', {}) if isinstance(row, dict) else {}
    t = parse_bitshares_time(key.get('open')) * 1000
    legs = [
        (_leg(row, 'open_base'), _leg(row, 'open_quote')),
        (_leg(row, 'high_base'), _leg(row, 'high_quote')),
        (_leg(row, 'low_base'), _leg(row, 'low_quote')),
        (_leg(row, 'close_base'), _leg(row, 'close_quote')),
    ]
    prices = []
    for b_sat, q_sat in legs:
        p = price_from_pair(b_sat, q_sat, base_prec, quote_prec)
        prices.append(p if (p is not None and p > 0) else None)
    o, h, l, c = prices
    if invert:
        # Back to requested BASE:QUOTE orientation by explicit inversion.
        # Reciprocation reverses order, so high/low swap: inverted high is
        # 1/(straight low) and vice versa. (This is the one place inversion
        # happens for candles, and it is flagged by the caller.)
        o, h, l, c = (
            (1.0 / o) if o is not None else None,
            (1.0 / l) if l is not None else None,
            (1.0 / h) if h is not None else None,
            (1.0 / c) if c is not None else None,
        )
    if o is None and h is None and l is None and c is None:
        return None
    # Partially-empty buckets reuse the nearest known leg (open seeds gaps
    # inside the bucket; close back-fills forward).
    seed = next((p for p in (o, c, h, l) if p is not None), None)
    o = o if o is not None else seed
    c = c if c is not None else (o if o is not None else seed)
    h = h if h is not None else max(o, c)
    l = l if l is not None else min(o, c)
    if invert:
        base_vol = amount_to_float(_leg(row, 'quote_volume'), quote_prec)
    else:
        base_vol = amount_to_float(_leg(row, 'base_volume'), base_prec)
    return {'t': t, 'o': o, 'h': h, 'l': l, 'c': c, 'v': base_vol}


def merge_candles(candles, bucket_s, limit=None):
    """Sort ascending, dedupe by ``t`` (last wins), gap-fill with prev close.

    Missing bucket slots become flat ``{o=h=l=c=prev_close, v=0}`` candles
    (gap-interp prev-close) so the series is contiguous. Returns ascending;
    keeps only the last ``limit`` rows when given.
    """
    ordered = {}
    for cd in candles or []:
        try:
            ordered[int(cd['t'])] = cd
        except (KeyError, TypeError, ValueError):
            continue
    if not ordered:
        return []
    step = int(bucket_s) * 1000
    keys = sorted(ordered)
    out = []
    prev_close = None
    cursor = bucket_start_ms(keys[0], bucket_s)
    last = keys[-1]
    while cursor <= last:
        row = ordered.get(cursor)
        if row is None:
            if prev_close is not None:
                out.append({'t': cursor, 'o': prev_close, 'h': prev_close,
                            'l': prev_close, 'c': prev_close, 'v': 0.0})
        else:
            out.append({'t': int(row['t']), 'o': float(row['o']),
                        'h': float(row['h']), 'l': float(row['l']),
                        'c': float(row['c']), 'v': float(row.get('v', 0.0))})
            prev_close = float(row['c'])
        cursor += step
    if limit is not None:
        out = out[-max(1, int(limit)):]
    return out


# ---------------------------------------------------------------------------
# Pure helpers: book / ticker / feeds
# ---------------------------------------------------------------------------

def book_to_depth(raw, base_prec, quote_prec, limit=50):
    """Normalise ``get_order_book`` to ``{'bids': [[p, a]], 'asks': ...}``.

    ``p`` is QUOTE per BASE, ``a`` is the base-asset amount (float BASE
    units); both converted from satoshi int-or-string legs. Sorted best
    first (bids desc, asks asc), truncated to ``limit`` (clamped 1..50).
    """
    n = clamp_depth_limit(limit)
    raw = raw or {}
    out = {'bids': [], 'asks': []}
    for side in ('bids', 'asks'):
        rows = []
        for entry in raw.get(side, []) or []:
            if not isinstance(entry, dict):
                continue
            try:
                price = price_from_pair(entry.get('base'), entry.get('quote'),
                                        base_prec, quote_prec)
                amount = amount_to_float(entry.get('base'), base_prec)
            except (ValueError, TypeError, AttributeError):
                price, amount = None, None
            if (price is None or price <= 0) and entry.get('price') is not None:
                # Some nodes attach a ready-made float leg; fall back to it
                # with the amount derived from the quote leg.
                try:
                    price = float(entry['price'])
                    amount = (amount_to_float(entry.get('quote'), quote_prec)
                              / price)
                except (ValueError, TypeError, ZeroDivisionError):
                    price, amount = None, None
            if price is None or price <= 0 or amount is None or amount <= 0:
                continue
            rows.append([price, amount])
        rows.sort(key=lambda r: r[0], reverse=(side == 'bids'))
        out[side] = rows[:n]
    return out


def ticker_to_quote(ticker, base_prec, quote_prec, bitasset=None, now=None):
    """Join ``get_ticker`` (+ optional bitasset info) into a quote dict.

    Returns ``{price, bid, ask, volume, change24h?, settlement_price?,
    feed_age_s?}``. Optional keys appear only when the wire data carries
    them (``None`` legs are dropped, never zero-filled).
    """
    t = ticker or {}
    q = {}
    # `latest` arrives either as a decimal-string/float price (node builds
    # it for the queried pair order) or, on older nodes, is absent and the
    # price must be derived from satoshi base/quote legs. Both shapes are
    # in the queried (API) orientation; flip handling stays with the caller.
    latest = None
    if t.get('latest') is not None:
        try:
            latest = float(t['latest'])
        except (TypeError, ValueError):
            latest = None
    if latest is None:
        try:
            latest = price_from_pair(t['base'], t['quote'],
                                     base_prec, quote_prec)
        except (KeyError, ValueError, TypeError):
            latest = None
    if latest and latest > 0:
        q['price'] = latest
    for wire_key, out_key in (
        ('highest_bid', 'bid'),
        ('lowest_ask', 'ask'),
    ):
        try:
            val = float(t[wire_key])
        except (KeyError, TypeError, ValueError):
            continue
        if val > 0:
            q[out_key] = val
    try:
        q['volume'] = amount_to_float(t.get('base_volume', 0), base_prec)
    except ValueError:
        pass
    try:
        chg = t.get('percent_change')
        if chg is not None:
            q['change24h'] = float(chg) / 100.0
    except (TypeError, ValueError):
        pass
    if bitasset:
        feeds = bitasset_to_feeds(bitasset, base_prec, quote_prec, now=now)
        if feeds.get('settlement_price') is not None:
            q['settlement_price'] = feeds['settlement_price']
        if feeds.get('feed_age_s') is not None:
            q['feed_age_s'] = feeds['feed_age_s']
    return q


def feed_age_s(publication_time, now=None):
    """Seconds since feed publication (``now`` epoch s; defaults to time)."""
    if publication_time is None:
        return None
    now_s = int(now if now is not None else time.time())
    if isinstance(publication_time, (int, float)):
        pub = int(publication_time)
    else:
        pub = parse_bitshares_time(publication_time)
    return now_s - pub


def is_feed_expired(publication_time, now=None, lifetime_s=FEED_LIFETIME_S):
    """True when the feed is older than ``lifetime_s`` (default 24h)."""
    age = feed_age_s(publication_time, now=now)
    if age is None:
        return True
    return age > int(lifetime_s)


def bitasset_to_feeds(bitasset, base_prec=5, quote_prec=5, now=None):
    """Reduce a ``get_bitasset_data`` object to feed facts.

    Returns ``{settlement_price, cer, mssr, mcr, publication_time,
    feed_age_s, expired}``. Ratios (MCR/MSSR) arrive in thousandths
    (``1750`` = 175%) and are converted to fractions (``1.75``).
    ``settlement_price``/``cer`` are QUOTE-per-BASE floats; ``expired``
    applies the 24h feed lifetime to the current-feed publication time.
    Missing legs yield ``None`` (and ``expired=True`` when no publication
    time exists) rather than invented zeros.
    """
    b = bitasset or {}
    feed = b.get('current_feed') or {}
    if not feed and isinstance(b.get('feeds'), list) and b['feeds']:
        # feeds: [[account_id, {settlement_price,...}], ...] — head = latest
        try:
            feed = b['feeds'][0][1] or {}
        except (IndexError, TypeError):
            feed = {}
    out = {'settlement_price': None, 'cer': None, 'mssr': None, 'mcr': None,
           'publication_time': None, 'feed_age_s': None, 'expired': True}

    def _ratio_amount(node):
        if not isinstance(node, dict):
            return None
        try:
            return price_from_pair(node.get('base'), node.get('quote'),
                                   base_prec, quote_prec)
        except (ValueError, TypeError):
            return None

    sp = _ratio_amount(feed.get('settlement_price'))
    # Wire orientation for settlement_price is (short-backing / debt) which
    # for bitUSD-style assets prices the bitasset in its backing asset —
    # already QUOTE-per-BASE for BASE:QUOTE callers; keep as-is.
    out['settlement_price'] = sp
    out['cer'] = _ratio_amount(feed.get('core_exchange_rate'))
    for wire_key, out_key in (('maximum_short_squeeze_ratio', 'mssr'),
                              ('maintenance_collateral_ratio', 'mcr')):
        try:
            raw = feed.get(wire_key)
            out[out_key] = int(raw) / 1000.0 if raw is not None else None
        except (TypeError, ValueError):
            out[out_key] = None
    pub = b.get('current_feed_publication_time') or feed.get('publication_time')
    out['publication_time'] = pub
    age = feed_age_s(pub, now=now) if pub is not None else None
    out['feed_age_s'] = age
    out['expired'] = True if age is None else age > FEED_LIFETIME_S
    return out


# ---------------------------------------------------------------------------
# Pure helper: ES query-body builder
# ---------------------------------------------------------------------------

def build_es_body(start_iso=None, end_iso=None, pool_id=None, account=None,
                  op_types=(ES_OP_POOL_SWAP,), size=ES_PAGE_SIZE,
                  search_after=None):
    """Build the ``POST bitshares-*/_search`` JSON body for pool history.

    Filters ``operation_type`` to ``op_types`` (default op-63 pool swaps;
    pass ``(63, 4)`` or ``(4,)`` to include/isolate op-4 fills — the
    caller, not this builder, decides the mix). Time bounds apply to the
    operation ``block_data.block_time``. Paging uses ``search_after`` with
    a stable ``(block_time, operation_id)`` sort; callers loop at most
    :data:`ES_MAX_PAGES` pages of :data:`ES_PAGE_SIZE` (8x10k budget) for
    pool history beyond the native 101-row trade-history cap.
    """
    must = [{'terms': {'operation_type': list(op_types)}}]
    if pool_id is not None:
        must.append({'term': {'pool_id': pool_id}})
    if account is not None:
        must.append({'term': {'account': account}})
    if start_iso is not None or end_iso is not None:
        rng = {}
        if start_iso is not None:
            rng['gte'] = start_iso
        if end_iso is not None:
            rng['lte'] = end_iso
        must.append({'range': {'block_data.block_time': rng}})
    body = {
        'size': min(int(size), ES_PAGE_SIZE),
        'sort': [{'block_data.block_time': 'asc'}, {'operation_id': 'asc'}],
        'query': {'bool': {'must': must}},
    }
    if search_after is not None:
        body['search_after'] = list(search_after)
    return body


def es_post(body, url=ES_URL, timeout=15):
    """POST a search body to ES via stdlib urllib; returns parsed JSON."""
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(url, data=data,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def es_pool_history(pool_id=None, start_iso=None, end_iso=None, account=None,
                    op_types=(ES_OP_POOL_SWAP,), max_pages=ES_MAX_PAGES):
    """Page ES pool-swap history with ``search_after`` (≤ ``max_pages``).

    Returns ``{'hits': [...raw hit dicts...], 'pages': n}``. Each page is at
    most :data:`ES_PAGE_SIZE` hits; the loop stops early on a short page.
    Raises ``Exception`` on transport/parse failure.
    """
    pages = min(max(1, int(max_pages)), ES_MAX_PAGES)
    all_hits, search_after, n = [], None, 0
    for _ in range(pages):
        body = build_es_body(start_iso, end_iso, pool_id, account, op_types,
                             ES_PAGE_SIZE, search_after)
        try:
            res = es_post(body)
        except Exception as exc:
            raise Exception('bitshares: ES query failed: %s' % (exc,))
        hits = ((res.get('hits') or {}).get('hits')) or []
        all_hits.extend(hits)
        n += 1
        if len(hits) < ES_PAGE_SIZE:
            break
        try:
            search_after = hits[-1]['sort']
        except (KeyError, IndexError, TypeError):
            break
    return {'hits': all_hits, 'pages': n}


# ---------------------------------------------------------------------------
# Live transport: latency sort, WS RPC, history probing
# ---------------------------------------------------------------------------

def _require_ws():
    if not WS_AVAILABLE or _ws is None:
        raise Exception('bitshares: %s' % INSTALL_HINT)


def tcp_latency_ms(url, timeout=WS_HANDSHAKE_TIMEOUT):
    """TCP-connect latency to a ``wss://host...`` URL (stdlib socket)."""
    host = str(url).split('://', 1)[-1].split('/', 1)[0].split('?')[0]
    hostname, _, port_s = host.partition(':')
    port = int(port_s) if port_s.isdigit() else 443
    start = time.monotonic()
    sock = socket.create_connection((hostname, port), timeout=timeout)
    try:
        return (time.monotonic() - start) * 1000.0
    finally:
        try:
            sock.close()
        except OSError:
            pass


def sort_nodes_by_latency(nodes=None, timeout=WS_HANDSHAKE_TIMEOUT):
    """Return node URLs fastest-first (unreachable nodes sink to the end)."""
    scored = []
    for url in list(nodes or SEED_NODES):
        try:
            scored.append((tcp_latency_ms(url, timeout=timeout), url))
        except (OSError, ValueError, socket.timeout):
            scored.append((float('inf'), url))
    scored.sort(key=lambda kv: kv[0])
    return [url for _, url in scored]


def _rpc(ws, api_id, method, params, req_id):
    ws.send(json.dumps({'id': req_id, 'jsonrpc': '2.0', 'method': 'call',
                        'params': [api_id, method, params]}))
    raw = ws.recv()
    try:
        res = json.loads(raw)
    except ValueError:
        raise Exception('bitshares: non-JSON RPC reply')
    if isinstance(res, dict) and res.get('error'):
        raise Exception('bitshares: RPC %s failed: %s' % (method, res['error']))
    return res.get('result')


class _Node(object):
    """One connected full node: login + database/history api ids."""

    def __init__(self, url):
        _require_ws()
        self.url = url
        self._seq = 0
        self.ws = _ws.create_connection(url, timeout=WS_HANDSHAKE_TIMEOUT)
        try:
            self.ws.settimeout(20)
        except Exception:
            pass
        self.db_api = None
        self.hist_api = None
        self._login()

    def _login(self):
        self._call(1, 'login', ['', ''])
        try:
            self.db_api = self._call(1, 'database', [])
        except Exception:
            self.db_api = self._call(1, 'get_api_by_name', ['database'])
        try:
            self.hist_api = self._call(1, 'history', [])
        except Exception:
            try:
                self.hist_api = self._call(1, 'get_api_by_name', ['history'])
            except Exception:
                self.hist_api = None

    def _call(self, api_id, method, params):
        self._seq += 1
        return _rpc(self.ws, api_id, method, params, self._seq)

    def db(self, method, params):
        return self._call(self.db_api, method, params)

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def connect_best(nodes=None):
    """Connect to the fastest reachable seed (fallbacks included)."""
    _require_ws()
    tried = []
    for url in sort_nodes_by_latency(list(nodes or SEED_NODES) + FALLBACK_NODES):
        try:
            return _Node(url)
        except Exception as exc:
            tried.append('%s (%s)' % (url, exc))
    raise Exception('bitshares: no node reachable: %s' % '; '.join(tried))


def probe_history_buckets(node):
    """Ask a node which bucket sizes its history plugin serves.

    Returns the raw ``get_market_history_buckets`` list. Raises when the
    node lacks the history plugin (caller tries the next node).
    """
    try:
        buckets = node.db('get_market_history_buckets', [])
    except Exception as exc:
        raise Exception('bitshares: history plugin missing/unreachable: %s'
                        % (exc,))
    if not buckets:
        raise Exception('bitshares: history plugin returned no buckets')
    return list(buckets)


def resolve_assets(node, base_sym, quote_sym):
    """Resolve ``(base_id, base_prec, quote_id, quote_prec)`` via
    ``lookup_asset_symbols`` + :data:`PRECISION_CACHE`."""
    need = [s for s in (base_sym, quote_sym)
            if s not in PRECISION_CACHE]
    if need:
        try:
            found = node.db('lookup_asset_symbols', [need])
        except Exception as exc:
            raise Exception('bitshares: asset lookup failed: %s' % (exc,))
        for asset in found or []:
            if not asset:
                continue
            PRECISION_CACHE[str(asset.get('symbol', '')).upper()] = (
                asset.get('id'), int(asset.get('precision', 0)))
    try:
        base_id, base_prec = PRECISION_CACHE[base_sym]
        quote_id, quote_prec = PRECISION_CACHE[quote_sym]
    except KeyError as exc:
        raise Exception('bitshares: unknown asset %s (lookup %s:%s)'
                        % (exc, base_sym, quote_sym))
    return base_id, base_prec, quote_id, quote_prec


# ---------------------------------------------------------------------------
# Contract surface
# ---------------------------------------------------------------------------

def venues():
    """Single-venue DEX: ``[{'id': 'bitshares', 'label': 'BitShares DEX'}]`."""
    return [{'id': VENUE_ID, 'label': LABEL}]


def _check_venue(venue):
    if str(venue or '').lower() != VENUE_ID:
        raise ValueError("unknown venue %r for source 'bitshares'" % (venue,))


def candles(venue, symbol, interval, limit=300):
    """Fetch ``[{t(ms), o, h, l, c, v}]`` ascending for ``BASE:QUOTE``.

    Resolves asset ids + precisions, normalises pair orientation by asset-id
    order (re-inverting explicitly so output stays ``BASE:QUOTE``), probes
    the history plugin for bucket support, then pages ``get_market_history``
    in ≤200-slot chunks and merges/sorts/dedupes with prev-close gap fill.
    Raises ``Exception`` (install hint / validation / upstream detail) on
    any failure — never substitutes another market's bars.
    """
    _check_venue(venue)
    bucket_s = validate_interval(interval)
    base_sym, quote_sym = parse_symbol(symbol)
    limit = max(1, min(1000, int(limit or 300)))
    _require_ws()

    node = connect_best()
    try:
        buckets = probe_history_buckets(node)
        if bucket_s not in [int(b) for b in buckets]:
            raise Exception(
                'bitshares: bucket %ss unsupported here; node offers %s'
                % (bucket_s, sorted(buckets)))
        base_id, base_prec, quote_id, quote_prec = resolve_assets(
            node, base_sym, quote_sym)
        # Pair orientation: canonical API order is ascending asset id; the
        # `flipped` flag is applied explicitly in conversion below so the
        # returned candles stay in requested BASE:QUOTE orientation.
        oriented = orient_pair(base_sym, base_id, quote_sym, quote_id)
        first_id = oriented['first_id']
        second_id = oriented['second_id']
        flipped = oriented['flipped']
        # Precision legs follow the API order, then map back: when flipped,
        # requested BASE is the API-second asset.
        if flipped:
            api_base_prec, api_quote_prec = quote_prec, base_prec
        else:
            api_base_prec, api_quote_prec = base_prec, quote_prec

        end_ms = bucket_start_ms(int(time.time() * 1000), bucket_s)
        start_ms = end_ms - limit * bucket_s * 1000
        raw_rows = []
        for start_iso, end_iso in chunk_ranges(start_ms, end_ms, bucket_s):
            try:
                page = node.db('get_market_history',
                               [first_id, second_id, bucket_s,
                                start_iso, end_iso])
            except Exception as exc:
                raise Exception('bitshares: get_market_history failed: %s'
                                % (exc,))
            raw_rows.extend(page or [])
        converted = []
        for row in raw_rows:
            cd = bucket_row_to_candle(row, api_base_prec, api_quote_prec,
                                      invert=flipped)
            if cd is not None:
                converted.append(cd)
        if not converted:
            raise Exception('bitshares: empty history for %s:%s @%s'
                            % (base_sym, quote_sym, interval))
        return merge_candles(converted, bucket_s, limit=limit)
    finally:
        node.close()


def search(venue, query):
    """Prefix-search DEX assets; each hit notes the ``BASE:QUOTE`` pairing.

    Returns ``[{'symbol': 'BTS', 'name': 'BTS (1.3.0) — pair as BASE:QUOTE'}]``.
    """
    _check_venue(venue)
    _require_ws()
    q = str(query or '').strip().upper()
    if not q:
        return []
    node = connect_best()
    try:
        try:
            found = node.db('lookup_asset_symbols', [[q]])
        except Exception:
            found = node.db('lookup_asset_symbols', [q, 20])
    except Exception as exc:
        raise Exception('bitshares: asset search failed: %s' % (exc,))
    finally:
        node.close()
    out = []
    for asset in found or []:
        if not isinstance(asset, dict) or not asset.get('symbol'):
            continue
        sym = str(asset['symbol']).upper()
        out.append({'symbol': sym,
                    'name': '%s (%s) — pair as BASE:QUOTE' % (
                        sym, asset.get('id', '?'))})
        if len(out) >= 20:
            break
    return out


def orderbook(base, quote, limit=50):
    """``get_order_book`` for ``BASE:QUOTE`` -> ``{bids, asks}`` floats.

    Prices in QUOTE per BASE, amounts in BASE units; satoshi int-or-string
    legs converted via :func:`amount_to_float`. ``limit`` clamped to 1..50.
    """
    _require_ws()
    base_sym = str(base).upper()
    quote_sym = str(quote).upper()
    n = clamp_depth_limit(limit)
    node = connect_best()
    try:
        base_id, base_prec, quote_id, quote_prec = resolve_assets(
            node, base_sym, quote_sym)
        oriented = orient_pair(base_sym, base_id, quote_sym, quote_id)
        try:
            raw = node.db('get_order_book',
                          [oriented['first_id'], oriented['second_id'], n])
        except Exception as exc:
            raise Exception('bitshares: get_order_book failed: %s' % (exc,))
        if oriented['flipped']:
            depth = book_to_depth(raw, quote_prec, base_prec, n)
            # book_to_depth priced API-first in API-second = QUOTE in BASE;
            # re-express explicitly in requested BASE:QUOTE orientation.
            fixed = {'bids': [], 'asks': []}
            for side in ('bids', 'asks'):
                for price, amount in depth[side]:
                    fixed[side].append(
                        [1.0 / price, amount * price])
                fixed[side].sort(key=lambda r: r[0],
                                 reverse=(side == 'bids'))
            return fixed
        return book_to_depth(raw, base_prec, quote_prec, n)
    finally:
        node.close()


def depth(venue, symbol, limit=50):
    """Contract wrapper: ``depth(venue, 'BASE:QUOTE', limit)``."""
    _check_venue(venue)
    base_sym, quote_sym = parse_symbol(symbol)
    return orderbook(base_sym, quote_sym, limit)


def quote(venue, symbol):
    """``get_ticker`` + ``get_bitasset_data`` join for ``BASE:QUOTE``.

    Returns ``{price, bid, ask, volume, change24h?, settlement_price?,
    feed_age_s?}`` — optional keys only when the wire data carries them.
    """
    _check_venue(venue)
    base_sym, quote_sym = parse_symbol(symbol)
    _require_ws()
    node = connect_best()
    try:
        base_id, base_prec, quote_id, quote_prec = resolve_assets(
            node, base_sym, quote_sym)
        oriented = orient_pair(base_sym, base_id, quote_sym, quote_id)
        try:
            ticker = node.db('get_ticker', [oriented['first_id'],
                                            oriented['second_id']])
        except Exception as exc:
            raise Exception('bitshares: get_ticker failed: %s' % (exc,))
        bitasset = None
        for cand_id in (base_id, quote_id):
            try:
                data = node.db('get_bitasset_data', [cand_id])
            except Exception:
                data = None
            if data:
                bitasset = data
                break
        if oriented['flipped']:
            q = ticker_to_quote(ticker, quote_prec, base_prec,
                                bitasset=bitasset)
            inv = {}
            for key in ('price', 'bid', 'ask', 'settlement_price'):
                if q.get(key):
                    inv[key] = 1.0 / q[key]
            for key in ('volume', 'change24h', 'feed_age_s'):
                if q.get(key) is not None:
                    inv[key] = q[key]
            # Volume was API-first (QUOTE) units; re-express in BASE units
            # via the price: v_base = v_quote / price_quote_per_base... the
            # un-inverted volume leg is QUOTE volume, so divide by price.
            if 'volume' in q and inv.get('price'):
                try:
                    inv['volume'] = float(q['volume']) / float(q['price'])
                except (TypeError, ValueError, ZeroDivisionError):
                    pass
            return inv
        return ticker_to_quote(ticker, base_prec, quote_prec,
                               bitasset=bitasset)
    finally:
        node.close()


def feeds(asset):
    """Fetch ``get_bitasset_data`` for *asset* (symbol or ``1.3.N`` id).

    Returns ``{settlement_price, cer, mssr, mcr, publication_time,
    feed_age_s, expired}`` — see :func:`bitasset_to_feeds`.
    """
    _require_ws()
    ref = str(asset or '').strip().upper()
    node = connect_best()
    try:
        if ref and not ref.startswith('1.3.'):
            resolve_assets(node, ref, ref)
            asset_id = PRECISION_CACHE[ref][0]
            prec = PRECISION_CACHE[ref][1]
        else:
            asset_id, prec = ref, 5
        try:
            data = node.db('get_bitasset_data', [asset_id])
        except Exception as exc:
            raise Exception('bitshares: get_bitasset_data failed: %s' % (exc,))
        if not data:
            raise Exception('bitshares: %s is not a bitasset (no feed data)'
                            % (asset,))
        return bitasset_to_feeds(data, prec, prec)
    finally:
        node.close()

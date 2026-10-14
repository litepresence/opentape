"""DEX pools companion source (workstream E).

Primary: DexPaprika REST (keyless) — pool OHLCV, pool search, token prices.
Fallback: GeckoTerminal REST (keyless) — pool OHLCV backfill + token price.

Stdlib only: urllib / json / time / re / datetime.

Pool id form is ``network:address``, e.g.
``ethereum:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640`` (EVM hex) or
``solana:6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN`` (base58).

Keyless plan notes (honest, no fake data):
- DexPaprika keyless serves OHLC intervals 1h and up over the last 24h;
  finer intervals / deeper history return 403 plan_required, credit
  exhaustion returns 402, per-minute overuse returns 429. All three raise
  BudgetError with the upstream message so the server can report them.
- GeckoTerminal keyless serves minute/hour/day OHLCV (aggregate-limited)
  with a ~30 calls/min public cap; it backfills when DexPaprika's window
  or budget is exhausted.

DexScreener is deliberately NEVER used for klines: its pair search/enrich
endpoints are fine for discovery, but it has no stable keyless OHLCV
contract, so charting from it would risk mislabeled candles. Live-only
honesty: an empty range raises 'no candles in range', never invented bars.
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SOURCE = 'dex'
LABEL = 'DEX Pools'
INTERVALS = ['1m', '5m', '15m', '30m', '1h', '6h', '12h', '24h']
STREAM = {
    'mode': 'poll',
    'cadence': 60,
    'note': 'free-tier delay \u226460s; keyless OHLC 1h+/24h on DexPaprika',
}

DEX_BASE = 'https://api.dexpaprika.com'
GECKO_BASE = 'https://api.geckoterminal.com/api/v2'

# Clamp per upstream page: DexPaprika allows up to 1000 but workstream E
# fixes 366 so one call covers a year of daily candles.
PAGE_LIMIT = 366

INTERVAL_SECONDS = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '6h': 21600,
    '12h': 43200,
    '24h': 86400,
}

# Static fallback: 36 DexPaprika network ids (coverage 2026-10-02).
STATIC_NETWORKS = [
    ('solana', 'Solana'),
    ('base', 'Base'),
    ('ethereum', 'Ethereum'),
    ('bsc', 'BNB Chain'),
    ('robinhood', 'Robinhood Chain'),
    ('arbitrum', 'Arbitrum'),
    ('avalanche', 'Avalanche'),
    ('hyperevm', 'HyperEVM'),
    ('polygon', 'Polygon'),
    ('arc', 'Arc'),
    ('monad', 'Monad'),
    ('tron', 'Tron'),
    ('sui', 'Sui'),
    ('optimism', 'Optimism'),
    ('x_layer', 'X Layer'),
    ('unichain', 'Unichain'),
    ('plasma', 'Plasma'),
    ('sei', 'Sei'),
    ('aptos', 'Aptos'),
    ('cronos', 'Cronos'),
    ('megaeth', 'MegaETH'),
    ('celo', 'Celo'),
    ('mantle', 'Mantle'),
    ('sonic', 'Sonic'),
    ('berachain', 'Berachain'),
    ('ton', 'Ton'),
    ('ronin', 'Ronin'),
    ('flow_evm', 'Flow EVM'),
    ('scroll', 'Scroll'),
    ('zksync', 'ZKsync'),
    ('katana', 'Katana'),
    ('linea', 'Linea'),
    ('blast', 'Blast'),
    ('bob_network', 'BOB Network'),
    ('tempo', 'Tempo'),
    ('fantom', 'Fantom'),
]

_NETWORK_RE = re.compile(r'^[a-z0-9_]{1,32}$')
_EVM_RE = re.compile(r'^0x[0-9a-fA-F]{20,64}$')
_BARE_HEX_RE = re.compile(r'^[0-9a-fA-F]{20,64}$')
_BASE58_RE = re.compile(r'^[A-Za-z0-9]{32,64}$')


class BudgetError(Exception):
    """Upstream budget/plan gate: 402 exhausted, 403 plan_required, 429 rate."""

    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = status


def interval_seconds(interval):
    """Seconds per candle for a supported interval id."""
    try:
        return INTERVAL_SECONDS[interval]
    except KeyError:
        raise ValueError(
            'unsupported interval %r (supported: %s)'
            % (interval, ', '.join(INTERVALS))
        )


def parse_pool_id(symbol):
    """Split ``network:address`` into (network, address).

    EVM pools use ``0x`` + hex; other chains (solana, sui, tron, ...) use a
    base58-style ``[A-Za-z0-9]`` address with length bounds. Raises
    ValueError on any other form.
    """
    if not isinstance(symbol, str) or symbol.count(':') != 1:
        raise ValueError('pool id must look like network:address, got %r' % (symbol,))
    network, address = symbol.split(':')
    if not _NETWORK_RE.match(network):
        raise ValueError('bad network in pool id %r' % (symbol,))
    if _EVM_RE.match(address):
        pass
    elif _BARE_HEX_RE.match(address):
        # All-hex without 0x is ambiguous with base58; EVM form requires
        # the prefix, so refuse rather than guess the wrong chain.
        raise ValueError('EVM address needs 0x prefix in %r' % (symbol,))
    elif not _BASE58_RE.match(address):
        raise ValueError('bad address in pool id %r' % (symbol,))
    if len(symbol) > 128:
        raise ValueError('pool id too long: %r' % (symbol,))
    return network, address


def venues():
    """Static venue list: one venue per DexPaprika network id."""
    return [{'id': net, 'label': label} for net, label in STATIC_NETWORKS]


def refresh_venues(base_url=DEX_BASE, timeout=10):
    """Live-merge GET /networks over the static list; static fallback offline.

    Returns [{id, label}]; live entries win on id, static ids fill any gap,
    and ANY transport/parse failure returns the static list (never raises).
    """
    static = venues()
    try:
        req = urllib.request.Request(
            base_url.rstrip('/') + '/networks',
            headers={'User-Agent': 'opentape-companion/1.0', 'Accept': 'application/json'},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except Exception:
        return static
    try:
        live = {}
        items = payload if isinstance(payload, list) else payload.get('networks', payload.get('results', []))
        for item in items:
            if not isinstance(item, dict):
                continue
            nid = item.get('id') or item.get('network') or item.get('slug')
            if not nid or not isinstance(nid, str):
                continue
            label = item.get('name') or item.get('label') or nid
            live[nid] = label
    except Exception:
        return static
    if not live:
        return static
    merged = [{'id': nid, 'label': label} for nid, label in sorted(live.items())]
    seen = set(live)
    for net, label in STATIC_NETWORKS:
        if net not in seen:
            merged.append({'id': net, 'label': label})
    return merged


# ---------------------------------------------------------------------------
# Interval mapping + URL builders (pure)

# GeckoTerminal OHLCV only serves timeframe/aggregate pairs:
#   minute: 1, 5, 15 | hour: 1, 4, 12 | day: 1
# Exact hits map 1:1; 30m and 6h fetch a finer grain and resample client-side
# (group N consecutive candles). gecko_spec returns (timeframe, aggregate,
# group) with group == 1 for exact hits.
_GECKO_EXACT = {
    '1m': ('minute', 1),
    '5m': ('minute', 5),
    '15m': ('minute', 15),
    '1h': ('hour', 1),
    '12h': ('hour', 12),
    '24h': ('day', 1),
}
_GECKO_RESAMPLE = {
    '30m': ('minute', 15, 2),
    '6h': ('hour', 1, 6),
}

# DexPaprika network id -> GeckoTerminal network id (best-effort; unknown
# ids pass through unchanged and Gecko answers 404 honestly).
GECKO_NETWORKS = {
    'ethereum': 'eth',
    'bsc': 'bsc',
    'polygon': 'polygon_pos',
    'arbitrum': 'arbitrum',
    'base': 'base',
    'optimism': 'optimism',
    'avalanche': 'avax',
    'solana': 'solana',
    'tron': 'tron',
    'zksync': 'zksync',
    'linea': 'linea',
    'scroll': 'scroll',
    'blast': 'blast',
    'ronin': 'ronin',
    'celo': 'celo',
    'mantle': 'mantle',
    'sonic': 'sonic',
    'berachain': 'berachain',
    'unichain': 'unichain',
    'sui': 'sui',
    'aptos': 'aptos',
    'cronos': 'cro',
}


def gecko_network(network):
    """Translate a DexPaprika network id to GeckoTerminal's id."""
    return GECKO_NETWORKS.get(network, network)


def gecko_spec(interval):
    """Map our interval to (timeframe, aggregate, resample_group)."""
    if interval in _GECKO_EXACT:
        timeframe, aggregate = _GECKO_EXACT[interval]
        return (timeframe, aggregate, 1)
    if interval in _GECKO_RESAMPLE:
        return _GECKO_RESAMPLE[interval]
    raise ValueError(
        'GeckoTerminal fallback has no mapping for %r (serves %s)'
        % (interval, ', '.join(INTERVALS))
    )


def build_dexpaprika_ohlcv_url(network, address, start, interval, limit):
    """DexPaprika pool klines URL (start = unix seconds, required)."""
    query = urllib.parse.urlencode(
        {'start': int(start), 'interval': interval, 'limit': int(limit)}
    )
    return '%s/networks/%s/pools/%s/ohlcv?%s' % (
        DEX_BASE,
        urllib.parse.quote(network, safe=''),
        urllib.parse.quote(address, safe=''),
        query,
    )


def build_gecko_ohlcv_url(network, address, timeframe, aggregate,
                           limit=366, before_timestamp=None):
    """GeckoTerminal pool klines URL (before_timestamp = unix seconds)."""
    params = {'aggregate': int(aggregate), 'limit': int(limit)}
    if before_timestamp is not None:
        params['before_timestamp'] = int(before_timestamp)
    return '%s/networks/%s/pools/%s/ohlcv/%s?%s' % (
        GECKO_BASE,
        urllib.parse.quote(network, safe=''),
        urllib.parse.quote(address, safe=''),
        timeframe,
        urllib.parse.urlencode(params),
    )


# ---------------------------------------------------------------------------
# Record parsing (pure)

_ISO_FORMATS = (
    '%Y-%m-%dT%H:%M:%SZ',
    '%Y-%m-%dT%H:%M:%S.%fZ',
    '%Y-%m-%dT%H:%M:%S%z',
    '%Y-%m-%dT%H:%M:%S.%f%z',
    '%Y-%m-%d',
)


def iso_to_ms(value):
    """Parse a DexPaprika ISO-8601 timestamp to epoch milliseconds."""
    if not isinstance(value, str):
        raise ValueError('bad timestamp %r' % (value,))
    text = value.strip().replace('Z', '+00:00') if value.endswith('Z') else value
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        moment = None
        for fmt in _ISO_FORMATS:
            try:
                moment = datetime.strptime(value, fmt)
                break
            except ValueError:
                continue
        if moment is None:
            raise ValueError('bad timestamp %r' % (value,))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp() * 1000)


def _to_candle(t, o, h, l, c, v):
    return {
        't': int(t),
        'o': float(o),
        'h': float(h),
        'l': float(l),
        'c': float(c),
        'v': float(v),
    }


def parse_dexpaprika_ohlcv(payload):
    """Map DexPaprika [{time_open,o,h,l,c,v}] to candle records.

    Malformed rows are skipped (never crash on one bad row); an empty or
    non-list payload yields [] so the caller can raise 'no candles in range'.
    """
    rows = []
    if not isinstance(payload, list):
        return rows
    for item in payload:
        try:
            rows.append(_to_candle(
                iso_to_ms(item['time_open']),
                item['open'], item['high'], item['low'],
                item['close'], item['volume'],
            ))
        except (KeyError, TypeError, ValueError):
            continue
    return rows


def parse_gecko_ohlcv(payload):
    """Map GeckoTerminal {data:{attributes:{ohlcv_list:[[ts,o,h,l,c,v]]}}}."""
    rows = []
    try:
        entries = payload['data']['attributes']['ohlcv_list']
    except (KeyError, TypeError, AttributeError):
        return rows
    if not isinstance(entries, list):
        return rows
    for entry in entries:
        try:
            ts, o, h, l, c, v = entry
            rows.append(_to_candle(int(ts) * 1000, o, h, l, c, v))
        except (TypeError, ValueError):
            continue
    return rows


# ---------------------------------------------------------------------------
# Merge / resample / fallback selection (pure)

def merge_candles(pages):
    """Merge [(provider, rows)] into ascending, timestamp-deduped candles.

    Later pages win on duplicate timestamps (cursor pagination advances
    start=last+interval, so overlap is only a boundary row). Returns
    (merged, providers) where providers lists, in first-seen order, every
    provider that served >= 1 row — the meta.fallback trail.
    """
    by_time = {}
    providers = []
    for provider, rows in pages:
        seen_rows = False
        for row in rows or []:
            try:
                by_time[int(row['t'])] = row
                seen_rows = True
            except (KeyError, TypeError, ValueError):
                continue
        if seen_rows and provider not in providers:
            providers.append(provider)
    merged = [by_time[t] for t in sorted(by_time)]
    return merged, providers


def resample_candles(rows, group):
    """Combine consecutive groups of `group` candles into one.

    o = first open, h = max high, l = min low, c = last close, v = summed,
    t = first timestamp. A trailing incomplete group is dropped (never
    invent a partial candle). group <= 1 returns a copy.
    """
    rows = list(rows or [])
    if group <= 1:
        return rows
    out = []
    for start in range(0, len(rows) - group + 1, group):
        chunk = rows[start:start + group]
        out.append({
            't': int(chunk[0]['t']),
            'o': float(chunk[0]['o']),
            'h': max(float(r['h']) for r in chunk),
            'l': min(float(r['l']) for r in chunk),
            'c': float(chunk[-1]['c']),
            'v': sum(float(r['v']) for r in chunk),
        })
    return out


# DexPaprika statuses after which the GeckoTerminal fallback is worth trying:
# budget/plan gates, a short page (window exhausted), or 404 (a pool the
# primary does not index may still exist on-chain under Gecko's id scheme).
_FALLBACK_STATUSES = (402, 403, 404, 429)


def fallback_plan(status, interval, short=False):
    """Which fallback providers to consult after a DexPaprika response.

    status: HTTP status of the primary response (200 on rows). short: True
    when fewer rows arrived than requested (window exhausted). Returns []
    when the primary answer stands, else ['geckoterminal'] (raising
    ValueError for intervals nothing can serve).
    """
    if status == 200 and not short:
        return []
    if status != 200 and status not in _FALLBACK_STATUSES:
        return []
    gecko_spec(interval)  # raises honestly if unmappable
    return ['geckoterminal']


# ---------------------------------------------------------------------------
# Budget errors (pure mapping; the HTTP layer raises them)

def _body_message(body):
    if isinstance(body, dict):
        for key in ('message', 'error', 'detail'):
            value = body.get(key)
            if isinstance(value, str) and value:
                return value
    elif isinstance(body, str) and body:
        return body[:300]
    return ''


def budget_error(status, body, provider='dexpaprika'):
    """Map 402/403/429 to BudgetError, else None.

    Pure: returns the exception (caller raises) so offline tests can assert
    the honest message. Non-budget statuses return None.
    """
    detail = _body_message(body)
    credits = ''
    retry = ''
    if isinstance(body, dict):
        creds = body.get('credits')
        if isinstance(creds, dict):
            limit = creds.get('limit', '?')
            remaining = creds.get('remaining', '?')
            credits = ' (credits limit=%s remaining=%s)' % (limit, remaining)
        retry_after = body.get('retry_after')
        if retry_after is None and status == 429:
            retry_after = '?'
        if retry_after is not None and status == 429:
            retry = ' retry after %ss.' % (retry_after,)
    if status == 402:
        return BudgetError(
            '%s credit budget exhausted (402 payment_required)%s: %s '
            'Register a free key or wait for the rolling window; '
            'GeckoTerminal fallback attempted where possible.'
            % (provider, credits, detail),
            status=status,
        )
    if status == 429:
        return BudgetError(
            '%s per-minute rate limit hit (429 rate_limited).%s%s'
            % (provider, retry, (' ' + detail) if detail else ''),
            status=status,
        )
    if status == 403:
        required = body.get('required_tier') if isinstance(body, dict) else None
        param = body.get('param') if isinstance(body, dict) else None
        hint = ''
        if required:
            hint = ' Requires %s plan.' % (required,)
        if param:
            hint += ' Gated parameter: %s.' % (param,)
        return BudgetError(
            '%s plan gate (403 plan_required): %s.%s Keyless serves '
            '1h+ intervals over the last 24h only.'
            % (provider, detail or 'outside keyless plan', hint),
            status=status,
        )
    return None


# ---------------------------------------------------------------------------
# Search + quote parsing (pure)

def format_usd(value):
    """Compact USD string for pool names: $1.5B / $150.0M / $3.4K / $12."""
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return 'n/a'
    for threshold, suffix in ((1e9, 'B'), (1e6, 'M'), (1e3, 'K')):
        if abs(amount) >= threshold:
            return '$%.1f%s' % (amount / threshold, suffix)
    if amount == int(amount):
        return '$%d' % int(amount)
    return '$%.2f' % amount


def format_pool_name(base, quote_sym, dex_name, liquidity_usd=None):
    """Human pool label: 'TOKEN/TOKEN · dex · liq'."""
    base = base or '?'
    quote_sym = quote_sym or '?'
    name = '%s/%s' % (base, quote_sym)
    if dex_name:
        name += ' \u00b7 %s' % (dex_name,)
    if liquidity_usd is not None:
        name += ' \u00b7 %s liq' % format_usd(liquidity_usd)
    return name


def _pool_address(item):
    # Live shape uses `id` for the pool address; older docs show `address`.
    for key in ('address', 'pool_address', 'id'):
        value = item.get(key)
        if isinstance(value, str) and value and ':' not in value:
            return value
    return None


def _short_addr(address):
    if len(address) > 14:
        return '%s\u2026%s' % (address[:6], address[-4:])
    return address


def _pool_symbols(item):
    """Best-effort (base, quote) token symbols from a pool object."""
    tokens = item.get('tokens')
    if isinstance(tokens, list):
        syms = [t.get('symbol') for t in tokens
                if isinstance(t, dict) and t.get('symbol')]
        if len(syms) >= 2:
            return syms[0], syms[1]
    pairs = [
        ('token0_symbol', 'token1_symbol'),
        ('base_token_symbol', 'quote_token_symbol'),
        ('base_symbol', 'quote_symbol'),
    ]
    for left, right in pairs:
        if item.get(left) and item.get(right):
            return item[left], item[right]
    name = item.get('name') or item.get('pair') or ''
    if isinstance(name, str) and '/' in name:
        parts = [p.strip() for p in name.split('/', 1)]
        if parts[0] and parts[1]:
            return parts[0], parts[1].split()[0]
    return None, None


def _pool_dex(item):
    for key in ('dex_name', 'dex', 'exchange', 'dex_name_display'):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return ''


def _pool_liquidity(item):
    for key in ('liquidity_usd', 'liquidity', 'tvl_usd', 'reserve_usd'):
        try:
            if item.get(key) is not None:
                return float(item[key])
        except (TypeError, ValueError):
            continue
    return None


def parse_pool_search(payload, network):
    """Map DexPaprika per-network pool search to [{symbol, name}]."""
    if isinstance(payload, dict):
        items = payload.get('results', payload.get('pools', payload.get('data', [])))
    elif isinstance(payload, list):
        items = payload
    else:
        return []
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        address = _pool_address(item)
        if not address:
            continue
        base, quote_sym = _pool_symbols(item)
        if base is None and quote_sym is None:
            # Per-network search omits token symbols; label by short pool
            # address so the hit still identifies its pool.
            name = _short_addr(address)
            dex_name = _pool_dex(item)
            if dex_name:
                name += ' \u00b7 %s' % dex_name
            liquidity = _pool_liquidity(item)
            if liquidity is not None:
                name += ' \u00b7 %s liq' % format_usd(liquidity)
        else:
            name = format_pool_name(base, quote_sym, _pool_dex(item),
                                    _pool_liquidity(item))
        out.append({'symbol': '%s:%s' % (network, address), 'name': name})
    return out


def parse_global_search(payload):
    """Map DexPaprika global /search to [{symbol, name}] (pool hits only).

    Token/dex hits carry no pool address, so they are skipped — a pool id
    must stay chartable, never a bare ticker.
    """
    if isinstance(payload, dict):
        items = payload.get('pools', payload.get('results', payload.get('data', [])))
    elif isinstance(payload, list):
        items = payload
    else:
        return []
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        address = _pool_address(item)
        network = None
        for key in ('network', 'chain', 'blockchain', 'network_id'):
            value = item.get(key)
            if isinstance(value, str) and _NETWORK_RE.match(value):
                network = value
                break
        if not address or not network:
            continue
        base, quote_sym = _pool_symbols(item)
        out.append({
            'symbol': '%s:%s' % (network, address),
            'name': format_pool_name(base, quote_sym, _pool_dex(item),
                                     _pool_liquidity(item)),
        })
    return out


def _token_price_fields(entry):
    """Best-effort (price, change24h|None) from a token price object."""
    price = None
    for key in ('price_usd', 'price'):
        try:
            if entry.get(key) is not None:
                price = float(entry[key])
                break
        except (TypeError, ValueError):
            continue
    if price is None:
        summary = entry.get('summary')
        if isinstance(summary, dict):
            try:
                if summary.get('price_usd') is not None:
                    price = float(summary['price_usd'])
            except (TypeError, ValueError):
                price = None
    if price is None:
        return None
    change = None
    for key in ('price_change_percentage_24h', 'price_change_24h', 'change_24h'):
        try:
            if entry.get(key) is not None:
                change = float(entry[key])
                break
        except (TypeError, ValueError):
            continue
    if change is None:
        try:
            change = float(entry['price_change_percentage']['h24'])
        except (KeyError, TypeError, ValueError):
            pass
    return price, change


def parse_dexpaprika_token(payload):
    """Map DexPaprika token detail to {price, change24h?}; ValueError if none."""
    if not isinstance(payload, dict):
        raise ValueError('empty token response')
    found = _token_price_fields(payload)
    if found is None:
        raise ValueError('no price in token response')
    price, change = found
    quote = {'price': price}
    if change is not None:
        quote['change24h'] = change
    return quote


def parse_gecko_token(payload):
    """Map GeckoTerminal token detail to {price, change24h?}."""
    try:
        entry = payload['data']['attributes']
    except (KeyError, TypeError):
        raise ValueError('empty token response')
    if not isinstance(entry, dict):
        raise ValueError('empty token response')
    found = _token_price_fields(entry)
    if found is None:
        raise ValueError('no price in token response')
    price, change = found
    quote = {'price': price}
    if change is not None:
        quote['change24h'] = change
    return quote


def parse_batch_prices(payload):
    """Map DexPaprika multi-prices {prices|data|tokens: {addr: entry}}."""
    if isinstance(payload, dict):
        for key in ('prices', 'data', 'tokens'):
            if isinstance(payload.get(key), dict):
                payload = payload[key]
                break
    if not isinstance(payload, dict):
        return {}
    out = {}
    for address, entry in payload.items():
        if not isinstance(entry, dict):
            continue
        found = _token_price_fields(entry)
        if found is None:
            continue
        price, change = found
        row = {'price': price}
        if change is not None:
            row['change24h'] = change
        out[address] = row
    return out


# ---------------------------------------------------------------------------
# Live HTTP layer + companion contract functions

_LAST_FETCH = {'providers': [], 'note': 'no fetch yet'}


def get_last_fetch_info():
    """Which providers served the last candles() call (meta.fallback trail)."""
    return {'providers': list(_LAST_FETCH['providers']),
            'note': _LAST_FETCH['note']}


def http_get_json(url, timeout=15):
    """GET JSON; raises BudgetError on 402/403/429, Exception otherwise bad."""
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'opentape-companion/1.0', 'Accept': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode('utf-8'))
        except Exception:
            body = ''
        budgeted = budget_error(exc.code, body)
        if budgeted is not None:
            raise budgeted
        if exc.code == 404:
            raise Exception('not found: %s' % url)
        raise Exception('upstream HTTP %s for %s: %s'
                        % (exc.code, url, _body_message(body) or 'no detail'))
    except urllib.error.URLError as exc:
        raise Exception('upstream unreachable (%s): %s' % (url, exc.reason))


def _check_symbol_venue(venue, symbol):
    network, address = parse_pool_id(symbol)
    if venue and venue != network:
        raise ValueError(
            'venue/network mismatch: venue=%r but symbol is on %r'
            % (venue, network)
        )
    return network, address


def candles(venue, symbol, interval, limit=300):
    """Pool klines ascending [{t, o, h, l, c, v}] (t = epoch ms).

    DexPaprika primary with start-cursor pagination (start=last+interval,
    dedupe+sort); GeckoTerminal backfills when the window or budget
    exhausts (resampling 30m/6h). Raises BudgetError on 402/403/429 that
    Gecko cannot cover, 'no candles in range' on empty ranges — never
    invented bars.
    """
    sec = interval_seconds(interval)  # ValueError names supported list
    try:
        want = int(limit)
    except (TypeError, ValueError):
        raise ValueError('bad limit %r' % (limit,))
    want = max(1, min(want, PAGE_LIMIT))
    network, address = _check_symbol_venue(venue, symbol)

    global _LAST_FETCH
    pages = []
    status = 200
    primary_error = None
    now = int(time.time())
    per_page = min(want, PAGE_LIMIT)
    start = now - want * sec
    for _ in range(4):  # bounded cursor walk; window exhaustion stops early
        url = build_dexpaprika_ohlcv_url(network, address, start, interval,
                                         per_page)
        try:
            status, payload = http_get_json(url)
        except BudgetError as exc:
            status = exc.status or 0
            primary_error = exc
            break
        rows = parse_dexpaprika_ohlcv(payload)
        pages.append(('dexpaprika', rows))
        if len(rows) < per_page or sum(len(r) for _, r in pages) >= want:
            break
        start = max(r['t'] for r in rows) // 1000 + sec

    merged, providers = merge_candles(pages)
    short = len(merged) < want
    plan = fallback_plan(status, interval,
                         short=short or primary_error is not None)

    if 'geckoterminal' in plan:
        timeframe, aggregate, group = gecko_spec(interval)
        gecko_net = gecko_network(network)
        need = (want - len(merged)) * group if merged else want * group
        need = max(need, group)
        before = (merged[0]['t'] // 1000 - 1) if merged else now
        gecko_rows = []
        for _ in range(3):  # bounded before_timestamp walk
            url = build_gecko_ohlcv_url(gecko_net, address, timeframe,
                                        aggregate,
                                        limit=min(need, 1000),
                                        before_timestamp=before)
            try:
                _, payload = http_get_json(url)
            except Exception:
                break  # best-effort backfill; primary error (if any) rules
            rows = parse_gecko_ohlcv(payload)
            if not rows:
                break
            rows.sort(key=lambda r: r['t'])
            gecko_rows.extend(rows)
            if len(gecko_rows) >= need or len(rows) < min(need, 1000):
                break
            before = rows[0]['t'] // 1000 - 1
        if group > 1:
            gecko_rows.sort(key=lambda r: r['t'])
            gecko_rows = resample_candles(gecko_rows, group)
        if gecko_rows:
            pages.append(('geckoterminal', gecko_rows))
            merged, providers = merge_candles(pages)

    if not merged:
        if primary_error is not None:
            raise primary_error
        raise Exception('no candles in range for %s @ %s' % (symbol, interval))
    merged = merged[-want:]
    note = '+'.join(providers) or 'dexpaprika'
    if gecko_spec(interval)[2] > 1 and 'geckoterminal' in providers:
        note += ' (resampled x%d)' % gecko_spec(interval)[2]
    _LAST_FETCH = {'providers': providers, 'note': note}
    return merged


def _is_address_like(query):
    text = (query or '').strip()
    if text.startswith('0x') and len(text) >= 10:
        return True
    return bool(re.fullmatch(r'[A-Za-z0-9]{30,64}', text))


def build_pool_search_url(network, params):
    """Per-network pool search URL (token_address/volume/order filters)."""
    return '%s/networks/%s/pools/search?%s' % (
        DEX_BASE, urllib.parse.quote(network, safe=''),
        urllib.parse.urlencode(params or {}))


def build_global_search_url(query):
    """Global search URL. Live API requires the `query` param (not `q`)."""
    return '%s/search?%s' % (
        DEX_BASE, urllib.parse.urlencode({'query': query}))


def search(venue, query):
    """Pool search -> [{symbol: 'network:address', name}].

    venue set: per-network pool search (token_address filter when the query
    is address-like, else top-by-volume filtered client-side). venue unset:
    global /search?q=. DexScreener is never consulted for klines (see note
    at top); it is not consulted here either — DexPaprika covers search.
    """
    query = (query or '').strip()
    if not query:
        return []
    if venue and _is_address_like(query):
        # Token lookup scoped to one network: per-network search with the
        # token_address filter, ordered by volume.
        url = build_pool_search_url(venue, {
            'token_address': query,
            'order_by': 'volume_usd_24h',
            'sort': 'desc',
            'limit': 25,
        })
        _, payload = http_get_json(url)
        return parse_pool_search(payload, venue)[:25]
    # Text queries (and venue-less address lookups) go through global
    # search, whose pool hits carry token symbols; a venue then filters
    # by chain. Per-network search has no text filter and omits symbols,
    # so it cannot serve text queries.
    _, payload = http_get_json(build_global_search_url(query))
    results = parse_global_search(payload)
    if venue:
        results = [r for r in results
                   if r['symbol'].split(':', 1)[0] == venue]
    return results[:25]


def quote(venue, symbol):
    """Token price -> {price, change24h?}, best-effort.

    DexPaprika token endpoint first, else GeckoTerminal token detail.
    symbol uses the same network:address form (a token address).
    """
    network, address = _check_symbol_venue(venue, symbol)
    errors = []
    try:
        _, payload = http_get_json(
            '%s/networks/%s/tokens/%s' % (
                DEX_BASE, urllib.parse.quote(network, safe=''),
                urllib.parse.quote(address, safe='')))
        return parse_dexpaprika_token(payload)
    except Exception as exc:  # noqa: BLE001 - best-effort, Gecko next
        errors.append(str(exc))
    try:
        _, payload = http_get_json(
            '%s/networks/%s/tokens/%s' % (
                GECKO_BASE, urllib.parse.quote(gecko_network(network), safe=''),
                urllib.parse.quote(address, safe='')))
        return parse_gecko_token(payload)
    except Exception as exc:  # noqa: BLE001 - honest combined failure
        errors.append(str(exc))
    raise Exception('quote failed for %s: %s' % (symbol, ' | '.join(errors)))


def batch_quotes(network, addresses, timeout=15):
    """Batched token prices via DexPaprika multi-prices (up to 10/call)."""
    addresses = [a for a in (addresses or []) if isinstance(a, str) and a][:10]
    if not addresses:
        return {}
    url = '%s/networks/%s/multi/prices?tokens=%s' % (
        DEX_BASE, urllib.parse.quote(network, safe=''),
        urllib.parse.quote(','.join(addresses), safe=','))
    _, payload = http_get_json(url, timeout=timeout)
    return parse_batch_prices(payload)

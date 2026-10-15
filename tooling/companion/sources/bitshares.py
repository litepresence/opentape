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

Transport (choice (a): stdlib-only raw WebSocket)
-------------------------------------------------
This module rolls its own read-only WebSocket client with the standard
library only (``socket`` + ``ssl`` handshake, client masking, text frames,
JSON-RPC). There is deliberately **no** wallet-focused signing dependency
(user constraint: huge, wallet-focused — never import it here), no
third-party WS pip package.
``WS_AVAILABLE`` is therefore always ``True`` and :func:`status` reports
``{'ok': True}``; live failures raise ``Exception`` with a
``'bitshares: ...'`` reason string so the companion can mark the source
degraded instead of crashing. Test evidence for the codec lives in
``tooling/companion/tests/test_bitshares.py`` (handshake accept-vector
from RFC 6455, masked round-trip, extended-length frames, ping/pong and
fragmentation handling, all with fake sockets — fully offline).

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

No GPL code is imported here (stdlib only).
"""

import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import time
import urllib.error
import urllib.parse
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

# Stdlib transport: nothing to install. Kept as a named constant so older
# callers/tests referencing INSTALL_HINT keep importing cleanly.
INSTALL_HINT = 'stdlib raw WebSocket (no extra package needed)'

#: Stdlib-only transport is always present.
WS_AVAILABLE = True


def status():
    """Availability probe for the companion server registry.

    Always ``{'ok': True}`` — the transport is stdlib-only, so there is no
    missing-dependency degraded state. Pure helpers work regardless.
    """
    return {'ok': True}


STATUS = {'ok': True, 'reason': None}

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

#: ES paging budget: at most 8 pages of 10k hits within 60s.
ES_MAX_PAGES = 8
ES_PAGE_SIZE = 10000
ES_TIME_BUDGET_S = 60.0
ES_URL = 'https://es.bitshares.dev/bitshares-*/_search'

#: BitShares operation types of interest on ES: 63 = liquidity-pool
#: exchange (AMM pool swap). NOTE: op-4 (fill_order, classic limit-order
#: fills) is a *separate* query/filter — never chart op-63 swaps and op-4
#: fills as one series without labelling which is which. The ES helpers in
#: this module are POOL records only (op-63); recent order-book fills stay
#: WS-native via ``get_fill_order_history``.
ES_OP_POOL_SWAP = 63
ES_OP_FILL = 4

#: Fields probed by the pool-id ``multi_match`` clause.
ES_POOL_FIELDS = [
    'pool_id',
    'pool',
    'operation_history.pool',
    'op_object.pool',
    'operation_result.pool',
]

#: XBTS REST daily klines are a documented **fallback-only** path for
#: order-book markets when both the node history plugin and ES are
#: unreachable. Daily only (no pool swaps, no intraday); see
#: :func:`xbts_fetch_daily`.
XBTS_REST_BASE = 'https://market-api-v2.xbts.io'
XBTS_REST_NOTE = (
    'fallback-only: XBTS REST daily klines '
    '(market-api-v2.xbts.io/v2/history) for order-book markets when node '
    'history + ES are unreachable; daily only, never for pool swaps'
)

WS_HANDSHAKE_TIMEOUT = 5  # seconds, per workstream spec

#: WebSocket close/ping opcodes (server frames).
_WS_OP_CONT = 0x0
_WS_OP_TEXT = 0x1
_WS_OP_BIN = 0x2
_WS_OP_CLOSE = 0x8
_WS_OP_PING = 0x9
_WS_OP_PONG = 0xA

WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

SEED_NODES = [
    'wss://api.bts.mobi/wss',
    'wss://eu.nodes.bitshares.ws/ws',
    'wss://dex.iobanker.com/wss',
    'wss://node.xbts.io/wss',
    'wss://public.xbts.io/ws',
    'wss://btsws.roelandp.nl/wss',
]

#: Extra public full nodes tried only after every seed node fails or lacks
#: the history plugin.
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


def parse_pool_id(pool_id):
    """Numeric suffix of a liquidity-pool id (``1.19.N`` -> ``N``)."""
    try:
        head, num = str(pool_id).rsplit('.', 1)
        if head != '1.19':
            raise ValueError
        return int(num)
    except (ValueError, AttributeError):
        raise ValueError('malformed pool id %r (want 1.19.N)' % (pool_id,))


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


def clamp_fill_limit(limit):
    """Fill-history clamp: 1..101 (native ``get_fill_order_history`` cap)."""
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = NATIVE_TRADE_HISTORY_CAP
    return max(1, min(NATIVE_TRADE_HISTORY_CAP, n))


# ---------------------------------------------------------------------------
# Raw WebSocket transport (stdlib only)
# ---------------------------------------------------------------------------

def ws_parse_url(url):
    """Parse a ``ws(s)://host[:port][/path][?q]`` URL.

    Returns ``(use_ssl, host, port, path)``. Raises ``ValueError`` on any
    malformed input (never returns a half-parsed tuple).
    """
    text = str(url or '').strip()
    if '://' not in text:
        raise ValueError('bad websocket URL %r' % (url,))
    scheme, _, rest = text.partition('://')
    scheme = scheme.lower()
    if scheme not in ('ws', 'wss'):
        raise ValueError('bad websocket scheme in %r' % (url,))
    use_ssl = (scheme == 'wss')
    # Split host[:port] from path; keep the query string in the path.
    if '/' in rest:
        hostport, _, path_suffix = rest.partition('/')
        path = '/' + path_suffix
    else:
        hostport, path = rest, '/'
    # Strip any userinfo (not expected on public nodes — refuse silently
    # embedding credentials).
    if '@' in hostport:
        raise ValueError('userinfo not allowed in websocket URL %r' % (url,))
    hostname, _, port_s = hostport.partition(':')
    hostname = hostname.strip('[]').strip()
    if not hostname:
        raise ValueError('missing host in websocket URL %r' % (url,))
    if port_s:
        if not port_s.isdigit():
            raise ValueError('bad port in websocket URL %r' % (url,))
        port = int(port_s)
    else:
        port = 443 if use_ssl else 80
    if not path:
        path = '/'
    return use_ssl, hostname, port, path


def ws_new_key():
    """Fresh ``Sec-WebSocket-Key`` (16 random bytes, base64)."""
    return base64.b64encode(os.urandom(16)).decode('ascii')


def ws_accept_key(key):
    """Expected ``Sec-WebSocket-Accept`` for a client key (RFC 6455)."""
    digest = hashlib.sha1(
        (str(key).strip() + WS_GUID).encode('ascii')).digest()
    return base64.b64encode(digest).decode('ascii')


def ws_build_handshake(host, path, key):
    """Build the HTTP Upgrade request bytes for *host*/*path*/*key*."""
    lines = [
        'GET %s HTTP/1.1' % (path or '/'),
        'Host: %s' % host,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: %s' % str(key).strip(),
        'Sec-WebSocket-Version: 13',
        'User-Agent: opentape-companion/1.0',
    ]
    return ('\r\n'.join(lines) + '\r\n\r\n').encode('ascii')


def _header_accept(resp_text, key):
    for line in resp_text.split('\r\n'):
        name, _, value = line.partition(':')
        if name.strip().lower() == 'sec-websocket-accept':
            return value.strip()
    return None


def ws_validate_handshake(resp_bytes, key):
    """Validate a server handshake reply; True or raise with reason."""
    try:
        text = bytes(resp_bytes).decode('latin-1')
    except (TypeError, ValueError):
        raise Exception('bitshares: WS handshake: undecodable reply')
    head, _, _ = text.partition('\r\n\r\n')
    status_line = head.split('\r\n', 1)[0] if head else ''
    if '101' not in status_line:
        raise Exception(
            'bitshares: WS handshake rejected: %s' % (status_line[:120],))
    got = _header_accept(head, key)
    want = ws_accept_key(key)
    if not got or got != want:
        raise Exception('bitshares: WS handshake accept mismatch')
    return True


def ws_encode_frame(text, mask_key=None, opcode=_WS_OP_TEXT):
    """Encode one client-masked frame (text by default).

    ``text`` may be ``str`` (utf-8) or ``bytes``. ``mask_key`` is 4 bytes;
    random when omitted (pass a fixed key in tests for determinism).
    ``opcode`` selects text/binary/continuation/ping/pong/close control
    frames for the transport internals.
    """
    if isinstance(text, str):
        payload = text.encode('utf-8')
    else:
        payload = bytes(text)
    if mask_key is None:
        mask_key = os.urandom(4)
    mask_key = bytes(mask_key)
    if len(mask_key) != 4:
        raise ValueError('mask_key must be 4 bytes')
    n = len(payload)
    b0 = 0x80 | (int(opcode) & 0x0F)
    if n < 126:
        header = bytes([b0, 0x80 | n])
    elif n < 65536:
        header = bytes([b0, 0x80 | 126]) + struct.pack('!H', n)
    else:
        header = bytes([b0, 0x80 | 127]) + struct.pack('!Q', n)
    masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return header + mask_key + masked


def ws_decode_frame(buf):
    """Decode one frame from *buf*.

    Returns ``(fin, opcode, payload_bytes, total_len)`` or ``None`` when
    *buf* holds an incomplete frame. Handles masked (client) and unmasked
    (server) frames plus 16/64-bit extended lengths.
    """
    data = bytes(buf)
    if len(data) < 2:
        return None
    b0, b1 = data[0], data[1]
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    idx = 2
    if length == 126:
        if len(data) < idx + 2:
            return None
        (length,) = struct.unpack('!H', data[idx:idx + 2])
        idx += 2
    elif length == 127:
        if len(data) < idx + 8:
            return None
        (length,) = struct.unpack('!Q', data[idx:idx + 8])
        idx += 8
    if masked:
        if len(data) < idx + 4:
            return None
        mask = data[idx:idx + 4]
        idx += 4
    else:
        mask = None
    if len(data) < idx + length:
        return None
    payload = data[idx:idx + length]
    if mask is not None:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return fin, opcode, payload, idx + length


def _recv_until(sock, marker=b'\r\n\r\n', limit=16384, timeout=WS_HANDSHAKE_TIMEOUT):
    """Read from *sock* until *marker* appears (handshake reply)."""
    sock.settimeout(timeout)
    chunks = []
    total = 0
    while marker not in b''.join(chunks):
        try:
            piece = sock.recv(4096)
        except socket.timeout:
            raise Exception('bitshares: WS handshake timed out')
        if not piece:
            break
        chunks.append(piece)
        total += len(piece)
        if total > limit:
            raise Exception('bitshares: WS handshake reply too large')
    return b''.join(chunks)


class RawWS(object):
    """Minimal read-only WebSocket client over stdlib sockets.

    Handles the HTTP Upgrade handshake, masked client text frames, server
    text/binary frames, fragmentation, ping->pong, and close. JSON-RPC
    rides on top via :func:`_rpc`.
    """

    def __init__(self, sock):
        self.sock = sock
        self._buf = b''

    @classmethod
    def connect(cls, url, timeout=WS_HANDSHAKE_TIMEOUT):
        """TCP (+TLS) connect + handshake; returns a ready instance."""
        use_ssl, host, port, path = ws_parse_url(url)
        try:
            sock = socket.create_connection((host, port), timeout=timeout)
        except (OSError, ValueError) as exc:
            raise Exception('bitshares: WS connect %s failed: %s'
                            % (url, exc))
        if use_ssl:
            try:
                ctx = ssl.create_default_context()
                sock = ctx.wrap_socket(sock, server_hostname=host)
            except (OSError, ssl.SSLError, ValueError) as exc:
                try:
                    sock.close()
                except OSError:
                    pass
                raise Exception('bitshares: WS TLS %s failed: %s'
                                % (url, exc))
        key = ws_new_key()
        try:
            sock.sendall(ws_build_handshake(host, path, key))
            reply = _recv_until(sock, timeout=timeout)
        except Exception:
            try:
                sock.close()
            except OSError:
                pass
            raise
        ws_validate_handshake(reply, key)
        try:
            sock.settimeout(20)
        except OSError:
            pass
        return cls(sock)

    def send_text(self, text):
        """Send one masked text frame."""
        try:
            self.sock.sendall(ws_encode_frame(text))
        except (OSError, socket.timeout) as exc:
            raise Exception('bitshares: WS send failed: %s' % (exc,))

    def _send_control(self, opcode, payload=b''):
        try:
            self.sock.sendall(ws_encode_frame(payload, opcode=opcode))
        except OSError:
            pass

    def _next_frame(self):
        """Read frames until one complete frame decodes."""
        while True:
            decoded = ws_decode_frame(self._buf)
            if decoded is not None:
                _, _, _, total = decoded
                frame = decoded
                self._buf = self._buf[total:]
                return frame
            try:
                piece = self.sock.recv(65536)
            except socket.timeout:
                raise Exception('bitshares: WS recv timed out')
            except OSError as exc:
                raise Exception('bitshares: WS recv failed: %s' % (exc,))
            if not piece:
                raise Exception('bitshares: WS connection closed by peer')
            self._buf += piece

    def recv_text(self):
        """Next complete text message (str); handles ping/fragmentation."""
        parts = []
        while True:
            fin, opcode, payload, _ = self._next_frame()
            if opcode == _WS_OP_CLOSE:
                raise Exception('bitshares: WS closed by server')
            if opcode == _WS_OP_PING:
                self._send_control(_WS_OP_PONG, payload)
                continue
            if opcode == _WS_OP_PONG:
                continue
            if opcode in (_WS_OP_TEXT, _WS_OP_BIN):
                parts = [payload]
            elif opcode == _WS_OP_CONT:
                parts.append(payload)
            else:
                continue
            if fin:
                try:
                    return b''.join(parts).decode('utf-8')
                except UnicodeDecodeError:
                    raise Exception('bitshares: WS non-utf8 text frame')
            # else: keep accumulating continuation frames

    def close(self):
        """Best-effort close (masked close frame + TCP close)."""
        try:
            self._send_control(_WS_OP_CLOSE, b'')
        except Exception:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def _require_ws():
    # Stdlib transport is always present; kept for call-site uniformity so
    # every live entrypoint fails with the same 'bitshares: ...' envelope.
    if not WS_AVAILABLE:
        raise Exception('bitshares: %s' % INSTALL_HINT)


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
# Pure helpers: book / ticker / feeds / fills
# ---------------------------------------------------------------------------

def _order_amount_flexible(value, prec):
    """Amount leg as float BASE/QUOTE units (satoshis or decimals).

    Graphene history/fill legs are integer satoshis, but live
    ``get_order_book``/``get_ticker`` legs arrive as decimal human-unit
    strings (``'116.19821'``). Try satoshis first via :func:`amount_to_float`
    (integer strings stay satoshis); fall back to ``float(value)`` for
    decimals. Raises ``ValueError`` when neither parses.
    """
    try:
        return amount_to_float(value, prec)
    except (ValueError, TypeError):
        pass
    if isinstance(value, bool):
        raise ValueError('bad amount %r' % (value,))
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValueError('bad amount %r' % (value,))


def book_to_depth(raw, base_prec, quote_prec, limit=50):
    """Normalise ``get_order_book`` to ``{'bids': [[p, a]], 'asks': ...}``.

    ``p`` is QUOTE per BASE, ``a`` is the base-asset amount (float BASE
    units); satoshi int-or-string legs convert via :func:`amount_to_float`,
    live decimal human-unit legs (``'116.19821'``) via ``float``. Sorted
    best first (bids desc, asks asc), truncated to ``limit`` (1..50).
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
            if price is None or price <= 0 or amount is None or amount <= 0:
                # Live decimal legs (human units, not satoshis).
                try:
                    base_f = _order_amount_flexible(entry.get('base'),
                                                    base_prec)
                    quote_f = _order_amount_flexible(entry.get('quote'),
                                                     quote_prec)
                    if base_f > 0:
                        price, amount = quote_f / base_f, base_f
                    else:
                        price, amount = None, None
                except (ValueError, TypeError, ZeroDivisionError):
                    price, amount = None, None
            if (price is None or price <= 0) and entry.get('price') is not None:
                # Some nodes attach a ready-made float leg; fall back to it
                # (already QUOTE-per-BASE per contract) with the amount
                # derived from either leg (satoshis or decimals).
                try:
                    price = float(entry['price'])
                    try:
                        quote_f = _order_amount_flexible(
                            entry.get('quote'), quote_prec)
                        amount = quote_f / price
                    except (ValueError, TypeError, ZeroDivisionError):
                        base_f = _order_amount_flexible(
                            entry.get('base'), base_prec)
                        amount = base_f
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
    feed_age_s?, feed_expired?}``. Optional keys appear only when the wire
    data carries them (``None`` legs are dropped, never zero-filled).
    ``feed_expired`` mirrors :func:`bitasset_to_feeds` ``expired`` whenever
    bitasset data is joined.
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
        q['volume'] = _order_amount_flexible(t.get('base_volume', 0),
                                             base_prec)
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
        if feeds.get('expired') is not None:
            q['feed_expired'] = bool(feeds['expired'])
            q['expired'] = bool(feeds['expired'])
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
    feed_pub = None
    if not feed and isinstance(b.get('feeds'), list) and b['feeds']:
        # feeds: [[account_id, {settlement_price,...}], ...] — head = latest.
        # Live `get_objects` nests one deeper: [account, [pub_time, {feed}]].
        try:
            candidate = b['feeds'][0][1] or {}
            if isinstance(candidate, (list, tuple)) and len(candidate) == 2 \
                    and isinstance(candidate[1], dict):
                feed_pub = candidate[0]
                feed = candidate[1]
            elif isinstance(candidate, dict):
                feed = candidate
            else:
                feed = {}
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
    pub = (b.get('current_feed_publication_time')
             or feed.get('publication_time') or feed_pub)
    out['publication_time'] = pub
    age = feed_age_s(pub, now=now) if pub is not None else None
    out['feed_age_s'] = age
    out['expired'] = True if age is None else age > FEED_LIFETIME_S
    return out


def _as_asset_amount(node):
    """Best-effort ``(asset_ref, satoshis_int)`` from an amount node.

    Accepts ``{'asset_id'|'asset'|'symbol': ref, 'amount': sats}`` (amount as
    int or numeric string), a ``[ref, sats]`` / ``[sats, ref]`` pair, or a
    bare ``{'amount': ...}`` with an adjacent asset key. Returns None when
    the shape is unrecognised (caller skips the hit, never guesses).
    """
    if isinstance(node, (list, tuple)) and len(node) == 2:
        a, b = node
        for ref, amt in ((a, b), (b, a)):
            try:
                if isinstance(ref, str) and ref:
                    sat = int(str(amt).strip())
                    return ref, sat
            except (ValueError, TypeError, AttributeError):
                continue
        return None
    if not isinstance(node, dict):
        return None
    ref = node.get('asset_id', node.get('asset', node.get('symbol')))
    if isinstance(ref, dict):
        ref = ref.get('id', ref.get('symbol'))
    amt = node.get('amount', node.get('quantity', node.get('value')))
    if ref is None or amt is None:
        return None
    try:
        if isinstance(amt, bool):
            return None
        if isinstance(amt, float):
            if not amt.is_integer():
                return None
            sat = int(amt)
        else:
            sat = int(str(amt).strip())
    except (ValueError, TypeError, AttributeError):
        return None
    return str(ref), sat


def _norm_asset(ref):
    return str(ref or '').strip().upper()


def fill_row_to_trade(row, base_prec, quote_prec, invert=False):
    """Normalise one ``get_fill_order_history`` row to ``{t, p, a}``.

    ``p`` is QUOTE per BASE, ``a`` is base volume; ``t`` is ms epoch. The
    wire row carries ``pays``/``receives`` satoshi legs plus a fill time
    (``time``/``fill_time``/``block_time``/``timestamp``). When ``invert``
    is True the legs are swapped explicitly back to requested BASE:QUOTE
    orientation. Returns None for rows with no tradable legs.
    """
    if not isinstance(row, dict):
        return None
    op = row.get('op', row)
    if isinstance(op, (list, tuple)) and len(op) == 2 and isinstance(op[1], dict):
        op = op[1]
    pays = _as_asset_amount(row.get('pays', (op.get('pays') if isinstance(op, dict) else None)))
    receives = _as_asset_amount(row.get('receives', (op.get('receives') if isinstance(op, dict) else None)))
    if pays is None or receives is None:
        # Some nodes nest under fill_* keys.
        pays = pays or _as_asset_amount(row.get('fill_pays'))
        receives = receives or _as_asset_amount(row.get('fill_receives'))
    if pays is None or receives is None:
        return None
    (pay_asset, pay_sat), (rec_asset, rec_sat) = pays, receives
    # Precisions follow the *API* order (caller passes API-order legs):
    # pays is API-first, receives is API-second. Price is rec/pay in API
    # orientation, then inverted once when the requested BASE sorted
    # second. Base volume is the requested-BASE leg (pays when straight,
    # receives when flipped) — i.e. pay_f / rec_f respectively.
    try:
        pay_f = amount_to_float(pay_sat, base_prec)
        rec_f = amount_to_float(rec_sat, quote_prec)
    except ValueError:
        return None
    if pay_f <= 0:
        return None
    price = rec_f / pay_f
    if invert and price > 0:
        price = 1.0 / price
    base_vol = rec_f if invert else pay_f
    if price <= 0 or base_vol <= 0:
        return None
    t_raw = (row.get('time', row.get('fill_time', row.get('block_time',
             row.get('timestamp', row.get('block_data', {}).get('block_time')
                     if isinstance(row.get('block_data'), dict) else None))))
             if isinstance(row, dict) else None)
    t_ms = None
    if t_raw is not None:
        try:
            if isinstance(t_raw, (int, float)):
                t_ms = int(t_raw * 1000) if float(t_raw) < 1e12 else int(t_raw)
            else:
                t_ms = parse_bitshares_time(t_raw) * 1000
        except (ValueError, TypeError):
            t_ms = None
    if t_ms is None:
        return None
    return {'t': t_ms, 'p': price, 'a': base_vol,
            'pay': pay_asset, 'rec': rec_asset}


# ---------------------------------------------------------------------------
# Pure helper: ES query-body builder (+ swap parsing / bucketing)
# ---------------------------------------------------------------------------

def build_es_body(start_iso=None, end_iso=None, pool_id=None, account=None,
                  op_types=(ES_OP_POOL_SWAP,), size=ES_PAGE_SIZE,
                  search_after=None):
    """Build the ``POST bitshares-*/_search`` JSON body for pool history.

    Shape per data-pipeline §1b: ``match`` on ``operation_type`` (op-63 pool
    swaps by default; pass ``(4,)`` to isolate op-4 fills — the caller, not
    this builder, decides the mix), ``multi_match`` on the pool id, and a
    ``block_data.block_time`` range. Sort is **descending**
    ``(block_time, operation_id)`` with ``search_after`` paging; callers
    loop at most :data:`ES_MAX_PAGES` pages of :data:`ES_PAGE_SIZE` (8x10k
    within a 60s budget) for pool history beyond the native 101-row
    trade-history cap. POOL records only — order-book fills stay WS-native
    via ``get_fill_order_history``.
    """
    ops = list(op_types) if op_types is not None else [ES_OP_POOL_SWAP]
    must = []
    if len(ops) == 1:
        must.append({'match': {'operation_type': ops[0]}})
    else:
        must.append({'terms': {'operation_type': list(ops)}})
    if pool_id is not None:
        must.append({'multi_match': {'query': str(pool_id),
                                     'fields': list(ES_POOL_FIELDS)}})
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
        'sort': [{'block_data.block_time': 'desc'},
                 {'operation_id': 'desc'}],
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


def es_search_after_for(hit):
    """Extract the ``search_after`` cursor for *hit* (stable desc paging)."""
    if isinstance(hit, dict) and isinstance(hit.get('sort'), list):
        return list(hit['sort'])
    src = hit.get('_source', {}) if isinstance(hit, dict) else {}
    if not isinstance(src, dict):
        return None
    block_time = None
    block = src.get('block_data')
    if isinstance(block, dict):
        block_time = block.get('block_time')
    block_time = block_time or src.get('block_time')
    op_id = src.get('operation_id', src.get('operation_id_num'))
    if block_time is None or op_id is None:
        return None
    return [block_time, op_id]


def es_pool_history(pool_id=None, start_iso=None, end_iso=None, account=None,
                    op_types=(ES_OP_POOL_SWAP,), max_pages=ES_MAX_PAGES,
                    time_budget_s=ES_TIME_BUDGET_S, timeout=15, _post=None):
    """Page ES pool-swap history with ``search_after`` (≤ ``max_pages``).

    Returns ``{'hits': [...raw hit dicts...], 'pages': n, 'capped': bool}``
    where ``capped`` is True when the walk stopped on the page budget or
    the 60s time budget while the last page was full (more data may remain).
    Each page is at most :data:`ES_PAGE_SIZE` hits; the loop stops early on
    a short page. Raises ``Exception`` on transport/parse failure.
    ``_post`` injects a fake POST for offline tests.
    """
    pages = min(max(1, int(max_pages)), ES_MAX_PAGES)
    post = _post or (lambda body: es_post(body, timeout=timeout))
    all_hits, search_after, n, capped = [], None, 0, False
    start = time.monotonic()
    for _ in range(pages):
        if time.monotonic() - start > float(time_budget_s):
            capped = bool(all_hits and n > 0)
            break
        body = build_es_body(start_iso, end_iso, pool_id, account, op_types,
                             ES_PAGE_SIZE, search_after)
        try:
            res = post(body)
        except Exception as exc:
            raise Exception('bitshares: ES query failed: %s' % (exc,))
        hits = ((res.get('hits') or {}).get('hits')) or []
        all_hits.extend(hits)
        n += 1
        if len(hits) < ES_PAGE_SIZE:
            break
        cursor = es_search_after_for(hits[-1])
        if cursor is None:
            break
        search_after = cursor
    else:
        # Exhausted the page budget with full pages — more may remain.
        capped = True
    return {'hits': all_hits, 'pages': n, 'capped': capped}


def es_hit_block_time_ms(hit):
    """Millisecond epoch of an ES hit's ``block_data.block_time``."""
    src = hit.get('_source', hit) if isinstance(hit, dict) else None
    if not isinstance(src, dict):
        return None
    block = src.get('block_data')
    raw = None
    if isinstance(block, dict):
        raw = block.get('block_time')
    raw = raw if raw is not None else src.get('block_time', src.get('timestamp'))
    if raw is None:
        return None
    try:
        if isinstance(raw, (int, float)):
            val = float(raw)
            return int(val * 1000) if val < 1e12 else int(val)
        return parse_bitshares_time(raw) * 1000
    except (ValueError, TypeError):
        return None


def es_hit_operation_type(hit):
    """Integer operation type of an ES hit, or None when absent."""
    src = hit.get('_source', hit) if isinstance(hit, dict) else None
    if not isinstance(src, dict):
        return None
    raw = src.get('operation_type')
    if raw is None:
        hist = src.get('operation_history')
        if isinstance(hist, dict):
            raw = hist.get('operation_type', hist.get('op_type'))
        elif isinstance(hist, (list, tuple)) and hist:
            raw = hist[0] if isinstance(hist[0], int) else None
        if raw is None and isinstance(src.get('op'), (list, tuple)):
            raw = src['op'][0] if isinstance(src['op'][0], int) else None
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def es_is_pool_record(hit):
    """True iff *hit* is a POOL swap record (op-63)."""
    return es_hit_operation_type(hit) == ES_OP_POOL_SWAP


def _candidate_op_object(src):
    if not isinstance(src, dict):
        return None
    for key in ('op_object', 'operation_object', 'op'):
        node = src.get(key)
        if isinstance(node, dict):
            return node
        if isinstance(node, (list, tuple)) and len(node) == 2 \
                and isinstance(node[1], dict):
            return node[1]
    hist = src.get('operation_history')
    if isinstance(hist, dict):
        for key in ('op_object', 'op'):
            node = hist.get(key)
            if isinstance(node, dict):
                return node
            if isinstance(node, (list, tuple)) and len(node) == 2 \
                    and isinstance(node[1], dict):
                return node[1]
    return None


def es_extract_swap(hit):
    """Extract a pool-swap ``{t_ms, pool, paid, received}`` from an ES hit.

    POOL records only: returns None for non-op-63 hits or unparsable legs.
    ``paid``/``received`` are ``{'asset': ref, 'amount': sats}`` with
    integer satoshis; ``t_ms`` is the block-time ms epoch. Tolerates the
    field-name drift across ES index shapes (``operation_result``,
    ``op_object`` pays/receives, nested ``operation_history``).
    """
    if not isinstance(hit, dict):
        return None
    if not es_is_pool_record(hit):
        return None
    src = hit.get('_source', hit)
    if not isinstance(src, dict):
        return None
    t_ms = es_hit_block_time_ms(hit)
    if t_ms is None:
        return None
    op_obj = _candidate_op_object(src) or {}
    pool = (src.get('pool_id', src.get('pool', op_obj.get('pool',
            op_obj.get('pool_id', src.get('liquidity_pool'))))))
    if isinstance(pool, dict):
        pool = pool.get('id', pool.get('pool_id'))
    pool = str(pool) if pool is not None else None
    result = src.get('operation_result', src.get('result', op_obj.get('result')))
    paid = received = None
    if isinstance(result, dict):
        for pay_keys, rec_keys in (
            (('paid',), ('received',)),
            (('pays', 'pay', 'sent', 'pays_amount'), ('receives', 'receive', 'received_amount')),
        ):
            for pk in pay_keys:
                if result.get(pk) is not None:
                    paid = _as_asset_amount(result[pk])
                    if paid is not None:
                        break
            for rk in rec_keys:
                if result.get(rk) is not None:
                    received = _as_asset_amount(result[rk])
                    if received is not None:
                        break
            if paid is not None and received is not None:
                break
        if (paid is None or received is None) and isinstance(result, dict):
            # Amount-pair form: {amount_a, amount_b, asset_a, asset_b}.
            try:
                aa = _as_asset_amount({'asset': result.get('asset_a', result.get('pool_asset_a')),
                                       'amount': result.get('amount_a')})
                bb = _as_asset_amount({'asset': result.get('asset_b', result.get('pool_asset_b')),
                                       'amount': result.get('amount_b')})
                if aa is not None and bb is not None:
                    paid, received = aa, bb
            except (TypeError, AttributeError):
                pass
    if isinstance(result, (list, tuple)) and len(result) == 2:
        paid = _as_asset_amount(result[0])
        received = _as_asset_amount(result[1])
    if paid is None or received is None:
        for pay_key in ('pays', 'pay', 'paid', 'sent'):
            for rec_key in ('receives', 'receive', 'received'):
                pay_node = op_obj.get(pay_key, src.get(pay_key))
                rec_node = op_obj.get(rec_key, src.get(rec_key))
                paid = paid or _as_asset_amount(pay_node)
                received = received or _as_asset_amount(rec_node)
    if paid is None or received is None:
        return None
    (pay_ref, pay_sat), (rec_ref, rec_sat) = paid, received
    if pay_sat <= 0 or rec_sat <= 0:
        return None
    return {'t_ms': int(t_ms), 'pool': pool,
            'paid': {'asset': str(pay_ref), 'amount': int(pay_sat)},
            'received': {'asset': str(rec_ref), 'amount': int(rec_sat)}}


def es_swap_price(swap, base_id, quote_id, base_prec, quote_prec):
    """Price + base volume for one swap in requested BASE:QUOTE orientation.

    Returns ``(price, base_volume)`` with ``price`` in QUOTE per BASE, or
    ``(None, None)`` when the swap legs do not match the pair. Legs paying
    BASE and receiving QUOTE price as received/paid; the reverse direction
    prices as paid/received (explicit orientation, never silent).
    """
    try:
        pay_ref = _norm_asset(swap['paid']['asset'])
        rec_ref = _norm_asset(swap['received']['asset'])
        pay_sat = int(swap['paid']['amount'])
        rec_sat = int(swap['received']['amount'])
    except (KeyError, TypeError, ValueError, AttributeError):
        return None, None
    base_n, quote_n = _norm_asset(base_id), _norm_asset(quote_id)
    try:
        if pay_ref == base_n and rec_ref == quote_n:
            price = amount_to_float(rec_sat, quote_prec) / amount_to_float(pay_sat, base_prec)
            vol = amount_to_float(pay_sat, base_prec)
        elif pay_ref == quote_n and rec_ref == base_n:
            price = amount_to_float(pay_sat, quote_prec) / amount_to_float(rec_sat, base_prec)
            vol = amount_to_float(rec_sat, base_prec)
        else:
            return None, None
    except (ValueError, ZeroDivisionError):
        return None, None
    if not price or price <= 0 or vol <= 0:
        return None, None
    return price, vol


def es_swaps_to_candles(hits, base_id, quote_id, base_prec, quote_prec,
                        bucket_s):
    """Bucket raw ES hits into ascending ``[{t,o,h,l,c,v}]`` (no gap-fill).

    POOL records only (non-op-63 hits skipped); legs oriented to requested
    BASE:QUOTE via :func:`es_swap_price`; ``floor(unix/bucket)`` bucketing
    (``t = floor(t_ms / bucket_ms) * bucket_ms``). Buckets sort ascending
    with ``o`` = first price, ``c`` = last, ``h/l`` = extremes, ``v`` =
    summed base volume. Returns [] when nothing parses.
    """
    step = int(bucket_s) * 1000
    buckets = {}
    order = {}
    for hit in hits or []:
        swap = es_extract_swap(hit)
        if swap is None:
            continue
        price, vol = es_swap_price(swap, base_id, quote_id,
                                   base_prec, quote_prec)
        if price is None or vol is None:
            continue
        bkt = (int(swap['t_ms']) // step) * step
        slot = buckets.setdefault(bkt, [])
        slot.append((int(swap['t_ms']), float(price), float(vol)))
    out = []
    for bkt in sorted(buckets):
        legs = sorted(buckets[bkt], key=lambda kv: kv[0])
        prices = [p for _, p, _ in legs]
        out.append({'t': int(bkt), 'o': prices[0], 'h': max(prices),
                    'l': min(prices), 'c': prices[-1],
                    'v': sum(v for _, _, v in legs)})
    return out


def pool_candles(pool_id, base_id, quote_id, base_prec, quote_prec,
                 interval, limit=300, start_iso=None, end_iso=None,
                 max_pages=ES_MAX_PAGES, _post=None):
    """ES pool-swap candles for one pool, ascending with prev-close fill.

    POOL records only (op-63). Raises with a ``'bitshares: ...'`` reason on
    validation failure or empty history — never substitutes another pool's
    bars. ``_post`` injects a fake ES POST for offline tests.
    """
    parse_pool_id(pool_id)
    bucket_s = validate_interval(interval)
    limit = max(1, min(1000, int(limit or 300)))
    page = es_pool_history(pool_id, start_iso, end_iso,
                           op_types=(ES_OP_POOL_SWAP,),
                           max_pages=max_pages, _post=_post)
    raw = es_swaps_to_candles(page['hits'], base_id, quote_id,
                              base_prec, quote_prec, bucket_s)
    if not raw:
        raise Exception('bitshares: empty pool history for %s' % (pool_id,))
    return merge_candles(raw, bucket_s, limit=limit)


# ---------------------------------------------------------------------------
# XBTS REST daily fallback (order-book markets only)
# ---------------------------------------------------------------------------

def build_xbts_history_url(base_sym, quote_sym, interval='1d', limit=300):
    """XBTS REST daily-history URL (fallback-only, order-book markets)."""
    query = urllib.parse.urlencode({
        'base': str(base_sym).upper(),
        'quote': str(quote_sym).upper(),
        'interval': str(interval),
        'limit': max(1, min(1000, int(limit or 300))),
    })
    return '%s/v2/history?%s' % (XBTS_REST_BASE.rstrip('/'), query)


def _xbts_num(value):
    if isinstance(value, bool):
        raise ValueError
    return float(value)


def xbts_parse_history(payload):
    """Parse an XBTS REST history payload to ascending candles.

    Accepts a bare list or ``{data|result|history|candles: [...]}`` with
    rows shaped ``{t|time|timestamp|date, o|open, h|high, l|low, c|close,
    v|volume}`` (ISO dates tolerated for ``t``). Malformed rows are skipped;
    returns [] when nothing parses.
    """
    if isinstance(payload, dict):
        for key in ('data', 'result', 'history', 'candles', 'rows'):
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
        else:
            return []
    if not isinstance(payload, list):
        return []
    out = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        raw_t = row.get('t', row.get('time', row.get('timestamp',
                 row.get('date', row.get('block_time')))))
        t_ms = None
        if raw_t is not None:
            try:
                if isinstance(raw_t, (int, float)) and not isinstance(raw_t, bool):
                    val = float(raw_t)
                    t_ms = int(val * 1000) if val < 1e12 else int(val)
                else:
                    t_ms = parse_bitshares_time(raw_t) * 1000
            except (ValueError, TypeError):
                t_ms = None
        if t_ms is None:
            continue
        try:
            o = _xbts_num(row.get('o', row.get('open')))
            h = _xbts_num(row.get('h', row.get('high')))
            l = _xbts_num(row.get('l', row.get('low')))
            c = _xbts_num(row.get('c', row.get('close')))
            v = _xbts_num(row.get('v', row.get('volume', 0.0)))
        except (TypeError, ValueError, KeyError, AttributeError):
            continue
        out.append({'t': int(t_ms), 'o': o, 'h': h, 'l': l, 'c': c, 'v': v})
    out.sort(key=lambda r: r['t'])
    deduped = {}
    for row in out:
        deduped[int(row['t'])] = row
    return [deduped[k] for k in sorted(deduped)]


def xbts_fetch_daily(base_sym, quote_sym, limit=300, timeout=15, _get=None):
    """Fetch XBTS REST daily candles (fallback-only, order-book markets).

    Raises ``Exception('bitshares: XBTS ...')`` on any failure or empty
    history. ``_get`` injects ``fn(url) -> payload`` for offline tests.
    """
    base = str(base_sym).upper()
    quote = str(quote_sym).upper()
    if not base or not quote:
        raise ValueError('XBTS fallback needs BASE and QUOTE symbols')
    url = build_xbts_history_url(base, quote, '1d', limit)
    try:
        if _get is not None:
            payload = _get(url)
        else:
            req = urllib.request.Request(
                url, headers={'User-Agent': 'opentape-companion/1.0',
                              'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:
        raise Exception('bitshares: XBTS fallback failed: %s' % (exc,))
    rows = xbts_parse_history(payload)
    if not rows:
        raise Exception('bitshares: XBTS fallback empty for %s:%s'
                        % (base, quote))
    want = max(1, min(1000, int(limit or 300)))
    return rows[-want:]


# ---------------------------------------------------------------------------
# Live transport: latency sort, WS RPC, history probing
# ---------------------------------------------------------------------------

def tcp_latency_ms(url, timeout=WS_HANDSHAKE_TIMEOUT):
    """TCP-connect latency to a ``wss://host...`` URL (stdlib socket)."""
    use_ssl, hostname, port, _ = ws_parse_url(url)
    del use_ssl
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
        except Exception:
            scored.append((float('inf'), url))
    scored.sort(key=lambda kv: kv[0])
    return [url for _, url in scored]


def _rpc(ws, api_id, method, params, req_id):
    ws.send_text(json.dumps({'id': req_id, 'jsonrpc': '2.0', 'method': 'call',
                             'params': [api_id, method, params]}))
    raw = ws.recv_text()
    try:
        res = json.loads(raw)
    except ValueError:
        raise Exception('bitshares: non-JSON RPC reply')
    if isinstance(res, dict) and res.get('error'):
        raise Exception('bitshares: RPC %s failed: %s' % (method, res['error']))
    return res.get('result')


class _Node(object):
    """One connected full node: login + database/history api ids."""

    def __init__(self, url, _connect=None):
        _require_ws()
        self.url = url
        self._seq = 0
        connect = _connect or RawWS.connect
        self.ws = connect(url, timeout=WS_HANDSHAKE_TIMEOUT)
        try:
            self.ws.sock.settimeout(20)
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

    def hist(self, method, params):
        if self.hist_api is None:
            raise Exception('bitshares: history API unavailable on %s'
                            % (self.url,))
        return self._call(self.hist_api, method, params)

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def connect_best(nodes=None, _connect=None):
    """Connect to the fastest reachable seed (fallbacks included)."""
    _require_ws()
    tried = []
    for url in sort_nodes_by_latency(list(nodes or SEED_NODES) + FALLBACK_NODES):
        try:
            return _Node(url, _connect=_connect)
        except Exception as exc:
            tried.append('%s (%s)' % (url, exc))
    raise Exception('bitshares: no node reachable: %s' % '; '.join(tried))


def probe_history_buckets(node):
    """Ask a node which bucket sizes its history plugin serves.

    The bucket list lives on the ``history`` API (``database`` answers
    ``method_not_found`` on live nodes — verified 2026-10-15 against
    ``node.xbts.io``/``public.xbts.io``); ``database`` is retried only as a
    legacy fallback. Returns the raw list. Raises when the node lacks the
    history plugin (caller tries the next node).
    """
    errors = []
    for caller in ('hist', 'db'):
        try:
            buckets = getattr(node, caller)('get_market_history_buckets', [])
        except Exception as exc:
            errors.append(str(exc))
            continue
        if not buckets:
            errors.append('%s returned no buckets' % caller)
            continue
        return list(buckets)
    raise Exception('bitshares: history plugin missing/unreachable: %s'
                    % (' | '.join(errors),))


def get_bitasset_data(node, asset_id):
    """Fetch bitasset data for a ``2.4.x`` object id or asset id.

    Tries ``database.get_bitasset_data`` first (per workstream spec), then
    falls back to ``database.get_objects([[id]])`` (live nodes answer the
    latter — verified 2026-10-15 — while the former 404s). Raises with a
    ``'bitshares: ...'`` reason when neither serves.
    """
    errors = []
    try:
        data = node.db('get_bitasset_data', [asset_id])
        if data:
            return data
    except Exception as exc:
        errors.append(str(exc))
    try:
        objs = node.db('get_objects', [[asset_id]])
        if objs and objs[0]:
            return objs[0]
    except Exception as exc:
        errors.append(str(exc))
    raise Exception('bitshares: get_bitasset_data failed for %s: %s'
                    % (asset_id, ' | '.join(errors)))


def fetch_bitasset_for(node, asset_id_13):
    """Bitasset data for a ``1.3.x`` asset id (or None when not a bitasset).

    Tries ``database.get_bitasset_data`` first (per workstream spec), then
    resolves the ``2.4.x`` id via ``database.get_objects`` (live nodes
    answer the latter — verified 2026-10-15: ``USD/1.3.121`` carries
    ``bitasset_data_id 2.4.21`` whose object holds ``current_feed`` +
    ``current_feed_publication_time``). Returns None (never raises) when the
    asset is not a bitasset; callers decide whether that is fatal.
    """
    try:
        data = node.db('get_bitasset_data', [asset_id_13])
        if data:
            return data
    except Exception:
        pass
    try:
        objs = node.db('get_objects', [[asset_id_13]])
    except Exception:
        return None
    bitasset_id = None
    try:
        if objs and isinstance(objs[0], dict):
            bitasset_id = objs[0].get('bitasset_data_id')
    except (IndexError, TypeError, AttributeError):
        bitasset_id = None
    if not bitasset_id:
        return None
    try:
        return get_bitasset_data(node, bitasset_id)
    except Exception:
        return None


def fetch_market_history(node, first_id, second_id, bucket_s,
                         start_iso, end_iso):
    """One ``get_market_history`` page via the history API (db fallback).

    Live nodes serve market history on ``history`` (verified 2026-10-15);
    ``database`` is retried only for legacy nodes.
    """
    errors = []
    if getattr(node, 'hist_api', None) is not None:
        try:
            return node.hist('get_market_history',
                             [first_id, second_id, bucket_s,
                              start_iso, end_iso])
        except Exception as exc:
            errors.append(str(exc))
    try:
        return node.db('get_market_history',
                       [first_id, second_id, bucket_s, start_iso, end_iso])
    except Exception as exc:
        errors.append(str(exc))
    raise Exception('bitshares: get_market_history failed: %s'
                    % (' | '.join(errors),))


def get_fill_order_history(node, first_id, second_id, limit=NATIVE_TRADE_HISTORY_CAP):
    """Recent order-book fills WS-native (history API, database fallback).

    Tries ``history.get_fill_order_history`` first, then
    ``database.get_fill_order_history``; raises with a reason when neither
    serves (caller tries the next node or surfaces honestly).
    """
    n = clamp_fill_limit(limit)
    errors = []
    if getattr(node, 'hist_api', None) is not None:
        try:
            return node.hist('get_fill_order_history', [first_id, second_id, n])
        except Exception as exc:
            errors.append(str(exc))
    try:
        return node.db('get_fill_order_history', [first_id, second_id, n])
    except Exception as exc:
        errors.append(str(exc))
    raise Exception('bitshares: get_fill_order_history failed: %s'
                    % (' | '.join(errors),))


def get_liquidity_pool_history(node, pool_id, limit=NATIVE_TRADE_HISTORY_CAP):
    """Native pool-swap tail (≤101 rows); ES serves anything deeper."""
    parse_pool_id(pool_id)
    n = clamp_fill_limit(limit)
    errors = []
    if getattr(node, 'hist_api', None) is not None:
        try:
            return node.hist('get_liquidity_pool_history', [pool_id, n])
        except Exception as exc:
            errors.append(str(exc))
    try:
        return node.db('get_liquidity_pool_history', [pool_id, n])
    except Exception as exc:
        errors.append(str(exc))
    raise Exception('bitshares: get_liquidity_pool_history failed: %s'
                    % (' | '.join(errors),))


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
    When the node history plugin is unreachable and ``interval == '1d'``,
    falls back to the documented XBTS REST daily path (order-book markets
    only); otherwise raises ``Exception`` with the upstream detail — never
    substitutes another market's bars.
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
        try:
            for start_iso, end_iso in chunk_ranges(start_ms, end_ms, bucket_s):
                page = fetch_market_history(node, first_id, second_id,
                                            bucket_s, start_iso, end_iso)
                raw_rows.extend(page or [])
        except Exception:
            # Documented fallback-only: XBTS REST daily for order-book
            # markets when node history is unreachable (daily only).
            if interval == '1d':
                try:
                    return xbts_fetch_daily(base_sym, quote_sym, limit)
                except Exception:
                    pass
            raise
        converted = []
        for row in raw_rows:
            cd = bucket_row_to_candle(row, api_base_prec, api_quote_prec,
                                      invert=flipped)
            if cd is not None:
                converted.append(cd)
        if not converted:
            if interval == '1d':
                try:
                    return xbts_fetch_daily(base_sym, quote_sym, limit)
                except Exception:
                    pass
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
    feed_age_s?, feed_expired?}`` — optional keys only when the wire data
    carries them. ``feed_expired`` (alias ``expired``) flags a stale/absent
    witness feed per the 24h ``feed_lifetime_sec`` rule.
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
            data = fetch_bitasset_for(node, cand_id)
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
            for key in ('feed_expired', 'expired'):
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
        if asset_id.startswith('2.4.'):
            data = get_bitasset_data(node, asset_id)
        else:
            data = fetch_bitasset_for(node, asset_id)
        if not data:
            raise Exception('bitshares: %s is not a bitasset (no feed data)'
                            % (asset,))
        return bitasset_to_feeds(data, prec, prec)
    finally:
        node.close()


def fills(base, quote, limit=NATIVE_TRADE_HISTORY_CAP):
    """Recent order-book fills WS-native (``get_fill_order_history``).

    Returns ascending ``[{t(ms), p(QUOTE per BASE), a(BASE volume)}]``.
    POOL swaps never appear here — use :func:`pool_candles` (ES, op-63)
    for those. Raises with a ``'bitshares: ...'`` reason on failure.
    """
    _require_ws()
    base_sym = str(base).upper()
    quote_sym = str(quote).upper()
    n = clamp_fill_limit(limit)
    node = connect_best()
    try:
        base_id, base_prec, quote_id, quote_prec = resolve_assets(
            node, base_sym, quote_sym)
        oriented = orient_pair(base_sym, base_id, quote_sym, quote_id)
        flipped = oriented['flipped']
        if flipped:
            api_base_prec, api_quote_prec = quote_prec, base_prec
        else:
            api_base_prec, api_quote_prec = base_prec, quote_prec
        try:
            rows = get_fill_order_history(node, oriented['first_id'],
                                          oriented['second_id'], n)
        except Exception as exc:
            raise Exception(str(exc))
        out = []
        for row in rows or []:
            trade = fill_row_to_trade(row, api_base_prec, api_quote_prec,
                                      invert=flipped)
            if trade is not None:
                out.append(trade)
        out.sort(key=lambda r: r['t'])
        return out[-n:]
    finally:
        node.close()


# Backwards-compatible alias (older callers/tests).
fill_history = fills

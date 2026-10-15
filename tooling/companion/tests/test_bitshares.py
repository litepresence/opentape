"""Offline unit tests for the BitShares companion source (workstream F).

Stdlib ``unittest`` only. Fully offline: no network, no pip packages.
Fake socket/HTTP fixtures cover the raw stdlib WebSocket transport
(handshake + masked frame codec), bucketing, precision conversion (incl.
satoshi strings), pair-orientation rule, feed-expiry math, ES query-body
builder (+ search_after paging budget + capped flag + swap parsing +
floor(unix/bucket) bucketing), XBTS REST fallback URL/parse, fill-history
normalisation, and validation errors (raised before any socket use).
"""

import base64
import importlib.util
import os
import unittest

_MOD_PATH = os.path.join(os.path.dirname(__file__), '..', 'sources',
                         'bitshares.py')
_MOD_PATH = os.path.abspath(_MOD_PATH)


def _load():
    spec = importlib.util.spec_from_file_location('bitshares_src', _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bs = _load()


# ---------------------------------------------------------------------------
# Fakes (offline fixtures)
# ---------------------------------------------------------------------------

class FakeSocket(object):
    """Minimal socket double for RawWS: scripted recv, recorded sends."""

    def __init__(self, recv_chunks):
        self._chunks = [bytes(c) for c in recv_chunks]
        self.sent = b''
        self.timeout = None
        self.closed = False

    def settimeout(self, timeout):
        self.timeout = timeout

    def sendall(self, data):
        self.sent += bytes(data)

    def recv(self, n):
        if not self._chunks:
            return b''
        head = self._chunks[0]
        if len(head) <= n:
            self._chunks.pop(0)
            return head
        self._chunks[0] = head[n:]
        return head[:n]

    def close(self):
        self.closed = True


def _server_frame(payload, opcode=0x1):
    """Build an *unmasked* server frame (as a real node would send)."""
    import struct
    if isinstance(payload, str):
        payload = payload.encode('utf-8')
    b0 = 0x80 | (opcode & 0x0F)
    n = len(payload)
    if n < 126:
        return bytes([b0, n]) + payload
    if n < 65536:
        return bytes([b0, 126]) + struct.pack('!H', n) + payload
    return bytes([b0, 127]) + struct.pack('!Q', n) + payload


def _es_hit(op_type=63, block_time='2026-01-01T00:00:00', pool='1.19.5',
            paid=('1.3.0', 100000), received=('1.3.121', 250),
            sort=None, op_id='1.11.1'):
    src = {
        'operation_type': op_type,
        'operation_id': op_id,
        'block_data': {'block_time': block_time},
        'operation_result': {
            'paid': {'asset_id': paid[0], 'amount': paid[1]},
            'received': {'asset_id': received[0], 'amount': received[1]},
        },
    }
    if pool is not None:
        src['pool_id'] = pool
    hit = {'_source': src}
    if sort is not None:
        hit['sort'] = list(sort)
    return hit


class FakeNode(object):
    def __init__(self, db_map=None, hist_map=None, hist_api=2):
        self.db_map = db_map or {}
        self.hist_map = hist_map or {}
        self.hist_api = hist_api
        self.calls = []

    def db(self, method, params):
        self.calls.append(('db', method, params))
        if method in self.db_map:
            val = self.db_map[method]
            return val(params) if callable(val) else val
        raise Exception('no such db method %s' % method)

    def hist(self, method, params):
        self.calls.append(('hist', method, params))
        if self.hist_api is None:
            raise Exception('history API unavailable')
        if method in self.hist_map:
            val = self.hist_map[method]
            return val(params) if callable(val) else val
        raise Exception('no such hist method %s' % method)


# ---------------------------------------------------------------------------
# Identity / transport choice
# ---------------------------------------------------------------------------

class TestIdentity(unittest.TestCase):
    def test_contract_ids(self):
        self.assertEqual(bs.SOURCE, 'bitshares')
        self.assertEqual(bs.LABEL, 'BitShares DEX')
        self.assertEqual(bs.INTERVALS,
                         ['1m', '5m', '15m', '30m', '1h', '4h', '1d'])

    def test_stream_poll_15(self):
        self.assertEqual(bs.STREAM['mode'], 'poll')
        self.assertEqual(bs.STREAM['cadence'], 15)

    def test_seed_nodes(self):
        for want in ('api.bts.mobi', 'eu.nodes.bitshares.ws',
                     'dex.iobanker.com', 'node.xbts.io', 'public.xbts.io',
                     'btsws.roelandp.nl'):
            self.assertTrue(any(want in u for u in bs.SEED_NODES), want)
        self.assertTrue(all(u.startswith('wss://') for u in bs.SEED_NODES))
        self.assertTrue(len(bs.FALLBACK_NODES) >= 1)

    def test_seed_nodes_exact_paths(self):
        # Per-task seed list (path matters: /wss vs /ws per host).
        for want in ('wss://api.bts.mobi/wss',
                     'wss://eu.nodes.bitshares.ws/ws',
                     'wss://dex.iobanker.com/wss',
                     'wss://node.xbts.io/wss',
                     'wss://public.xbts.io/ws',
                     'wss://btsws.roelandp.nl/wss'):
            self.assertIn(want, bs.SEED_NODES, want)
        self.assertEqual(bs.WS_HANDSHAKE_TIMEOUT, 5)

    def test_venues_single(self):
        self.assertEqual(bs.venues(),
                         [{'id': 'bitshares', 'label': 'BitShares DEX'}])

    def test_stdlib_transport_always_available(self):
        # Choice (a): stdlib-only raw WS — always importable, no pip dep.
        self.assertTrue(bs.WS_AVAILABLE)
        self.assertEqual(bs.status(), {'ok': True})

    def test_no_forbidden_imports(self):
        with open(_MOD_PATH, 'r', encoding='utf-8') as fh:
            text = fh.read()
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith('import ') or stripped.startswith('from '):
                low = stripped.lower()
                self.assertNotIn('websocket', low,
                                 'websocket-client import forbidden: %r' % line)
                self.assertNotIn('python-bitshares', low)
                self.assertNotIn('bitshares.bitshares', low)
                self.assertNotIn('graphene', low)
        # No third-party websocket module is needed at runtime either.
        self.assertFalse(hasattr(bs, '_ws'))


# ---------------------------------------------------------------------------
# Raw WebSocket URL / handshake
# ---------------------------------------------------------------------------

class TestWsUrl(unittest.TestCase):
    def test_wss_defaults(self):
        ssl_on, host, port, path = bs.ws_parse_url('wss://api.bts.mobi/wss')
        self.assertTrue(ssl_on)
        self.assertEqual((host, port, path), ('api.bts.mobi', 443, '/wss'))

    def test_ws_default_port_and_root(self):
        ssl_on, host, port, path = bs.ws_parse_url('ws://localhost')
        self.assertFalse(ssl_on)
        self.assertEqual((host, port, path), ('localhost', 80, '/'))

    def test_custom_port_and_query(self):
        ssl_on, host, port, path = bs.ws_parse_url(
            'wss://example.com:8443/ws?node=1')
        self.assertEqual((host, port, path),
                         ('example.com', 8443, '/ws?node=1'))

    def test_rejects_bad(self):
        for bad in ('http://x/y', 'wss://', 'wss://host:abc/ws',
                    'notaurl', '', None, 'wss://user@host/ws'):
            with self.assertRaises(ValueError, msg=repr(bad)):
                bs.ws_parse_url(bad)


class TestHandshake(unittest.TestCase):
    # RFC 6455 §1.3 accept vector.
    RFC_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='
    RFC_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='

    def test_new_key_is_16_random_bytes(self):
        key = bs.ws_new_key()
        self.assertEqual(len(base64.b64decode(key)), 16)
        self.assertNotEqual(bs.ws_new_key(), bs.ws_new_key())

    def test_accept_vector(self):
        self.assertEqual(bs.ws_accept_key(self.RFC_KEY), self.RFC_ACCEPT)

    def test_build_request_headers(self):
        req = bs.ws_build_handshake('example.com', '/ws', self.RFC_KEY)
        text = req.decode('ascii')
        self.assertTrue(text.startswith('GET /ws HTTP/1.1\r\n'))
        self.assertIn('Host: example.com\r\n', text)
        self.assertIn('Upgrade: websocket\r\n', text)
        self.assertIn('Connection: Upgrade\r\n', text)
        self.assertIn('Sec-WebSocket-Key: %s\r\n' % self.RFC_KEY, text)
        self.assertIn('Sec-WebSocket-Version: 13\r\n', text)

    def test_validate_ok(self):
        reply = ('HTTP/1.1 101 Switching Protocols\r\n'
                 'Upgrade: websocket\r\n'
                 'Connection: Upgrade\r\n'
                 'Sec-WebSocket-Accept: %s\r\n\r\n' % self.RFC_ACCEPT)
        self.assertTrue(
            bs.ws_validate_handshake(reply.encode('latin-1'), self.RFC_KEY))

    def test_validate_rejects_status(self):
        reply = ('HTTP/1.1 200 OK\r\n'
                 'Sec-WebSocket-Accept: %s\r\n\r\n' % self.RFC_ACCEPT)
        with self.assertRaises(Exception) as ctx:
            bs.ws_validate_handshake(reply.encode('latin-1'), self.RFC_KEY)
        self.assertIn('bitshares:', str(ctx.exception))

    def test_validate_rejects_bad_accept(self):
        reply = ('HTTP/1.1 101 Switching Protocols\r\n'
                 'Sec-WebSocket-Accept: bogus\r\n\r\n')
        with self.assertRaises(Exception) as ctx:
            bs.ws_validate_handshake(reply.encode('latin-1'), self.RFC_KEY)
        self.assertIn('bitshares:', str(ctx.exception))


# ---------------------------------------------------------------------------
# Frame codec (+ RawWS with fake socket)
# ---------------------------------------------------------------------------

class TestFrameCodec(unittest.TestCase):
    def test_masked_roundtrip(self):
        frame = bs.ws_encode_frame('hello', mask_key=b'\x01\x02\x03\x04')
        # Client frames must be masked.
        self.assertTrue(frame[1] & 0x80)
        decoded = bs.ws_decode_frame(frame)
        self.assertIsNotNone(decoded)
        fin, opcode, payload, total = decoded
        self.assertTrue(fin)
        self.assertEqual(opcode, 0x1)
        self.assertEqual(payload, b'hello')
        self.assertEqual(total, len(frame))

    def test_server_unmasked_decode(self):
        frame = _server_frame('hi')
        self.assertFalse(frame[1] & 0x80)
        fin, opcode, payload, total = bs.ws_decode_frame(frame)
        self.assertEqual((payload, total), (b'hi', len(frame)))

    def test_extended_126_length(self):
        big = 'x' * 200
        frame = bs.ws_encode_frame(big, mask_key=b'\x00' * 4)
        self.assertEqual(frame[1] & 0x7F, 126)
        _, _, payload, _ = bs.ws_decode_frame(frame)
        self.assertEqual(payload, big.encode('utf-8'))

    def test_extended_127_length(self):
        big = 'y' * 70000
        frame = bs.ws_encode_frame(big, mask_key=b'\x00' * 4)
        self.assertEqual(frame[1] & 0x7F, 127)
        _, _, payload, _ = bs.ws_decode_frame(frame)
        self.assertEqual(len(payload), 70000)

    def test_incomplete_returns_none(self):
        self.assertIsNone(bs.ws_decode_frame(b''))
        self.assertIsNone(bs.ws_decode_frame(b'\x81'))
        full = bs.ws_encode_frame('hello', mask_key=b'\x01\x02\x03\x04')
        self.assertIsNone(bs.ws_decode_frame(full[:3]))

    def test_binary_and_continuation_opcodes(self):
        frame = bs.ws_encode_frame(b'\x00\xff', mask_key=b'abcd', opcode=0x2)
        fin, opcode, payload, _ = bs.ws_decode_frame(frame)
        self.assertEqual(opcode, 0x2)
        self.assertEqual(payload, b'\x00\xff')


class TestRawWS(unittest.TestCase):
    def test_recv_text_single_frame(self):
        sock = FakeSocket([_server_frame('{"id":1,"result":5}')])
        ws = bs.RawWS(sock)
        self.assertEqual(ws.recv_text(), '{"id":1,"result":5}')

    def test_recv_handles_fragmentation(self):
        # FIN=0 text "he" + FIN=1 continuation "llo".
        f1 = bytes([0x01, 2]) + b'he'
        f2 = bytes([0x80, 3]) + b'llo'
        sock = FakeSocket([f1 + f2])
        ws = bs.RawWS(sock)
        self.assertEqual(ws.recv_text(), 'hello')

    def test_recv_answers_ping_then_text(self):
        ping = _server_frame('p', opcode=0x9)
        text = _server_frame('ok')
        sock = FakeSocket([ping + text])
        ws = bs.RawWS(sock)
        self.assertEqual(ws.recv_text(), 'ok')
        # A masked pong (opcode 0xA) must have been sent.
        sent_op = bs.ws_decode_frame(sock.sent)[1]
        self.assertEqual(sent_op, 0xA)

    def test_recv_close_raises_with_reason(self):
        sock = FakeSocket([_server_frame('', opcode=0x8)])
        ws = bs.RawWS(sock)
        with self.assertRaises(Exception) as ctx:
            ws.recv_text()
        self.assertIn('bitshares:', str(ctx.exception))

    def test_send_masks_client_frames(self):
        sock = FakeSocket([])
        ws = bs.RawWS(sock)
        ws.send_text('hi')
        self.assertTrue(sock.sent[1] & 0x80)


# ---------------------------------------------------------------------------
# Intervals / bucketing / precision / orientation
# ---------------------------------------------------------------------------

class TestIntervals(unittest.TestCase):
    def test_bucket_map(self):
        self.assertEqual(
            {k: bs.bucket_seconds(k) for k in bs.INTERVALS},
            {'1m': 60, '5m': 300, '15m': 900, '30m': 1800,
             '1h': 3600, '4h': 14400, '1d': 86400})

    def test_invalid_lists_supported(self):
        for bad in ('1s', '2h', '1wk', '', '1D', None):
            with self.assertRaises(ValueError) as ctx:
                bs.validate_interval(bad)
            msg = str(ctx.exception)
            for supported in bs.INTERVALS:
                self.assertIn(supported, msg)

    def test_bucket_floor(self):
        # 2026-01-01T00:00:30Z == 1767225630000 ms; 1m bucket opens at :00.
        self.assertEqual(bs.bucket_start_ms(1767225630000, 60), 1767225600000)
        self.assertEqual(bs.bucket_start_ms(1767225600000, 3600),
                         1767225600000)
        # 4h buckets align to epoch multiples.
        self.assertEqual(bs.bucket_start_ms(1767225630000, 14400) % 14400000,
                         0)

    def test_floor_unix_div_bucket(self):
        # floor(unix/bucket) bucketing used by the ES pool path.
        self.assertEqual(bs.bucket_start_ms(1767225630123, 60), 1767225600000)
        self.assertEqual(bs.bucket_start_ms(1767225600000, 86400) % 86400000,
                         0)


class TestPrecision(unittest.TestCase):
    def test_int_and_string_agree(self):
        self.assertAlmostEqual(bs.amount_to_float(12345, 5), 0.12345)
        self.assertAlmostEqual(bs.amount_to_float('12345', 5), 0.12345)
        self.assertAlmostEqual(bs.amount_to_float('  12345 ', 5), 0.12345)

    def test_zero_precision(self):
        self.assertEqual(bs.amount_to_float('42', 0), 42.0)

    def test_bad_amount_raises(self):
        for bad in ('12.5', 'abc', '', None, True, '1e3'):
            with self.assertRaises(ValueError, msg=repr(bad)):
                bs.amount_to_float(bad, 5)

    def test_price_from_pair(self):
        # 1.00000 BASE (100000 sats @5) vs 2.50 QUOTE (250 sats @2).
        self.assertAlmostEqual(
            bs.price_from_pair(100000, 250, 5, 2), 2.5)
        self.assertIsNone(bs.price_from_pair(0, 250, 5, 2))
        self.assertIsNone(bs.price_from_pair('0', 250, 5, 2))


class TestOrientation(unittest.TestCase):
    def test_ascending_first_no_flip(self):
        o = bs.orient_pair('BTS', '1.3.0', 'bitUSD', '1.3.121')
        self.assertEqual((o['first_id'], o['second_id']),
                         ('1.3.0', '1.3.121'))
        self.assertFalse(o['flipped'])

    def test_descending_flips_with_flag(self):
        # Requested BASE has the bigger id -> canonical order flips, and
        # the flip is REPORTED (never silent).
        o = bs.orient_pair('bitUSD', '1.3.121', 'BTS', '1.3.0')
        self.assertEqual((o['first_id'], o['second_id']),
                         ('1.3.0', '1.3.121'))
        self.assertTrue(o['flipped'])
        self.assertEqual(o['first_symbol'], 'BTS')

    def test_identical_rejected(self):
        with self.assertRaises(ValueError):
            bs.orient_pair('BTS', '1.3.0', 'BTS', '1.3.0')

    def test_malformed_id_rejected(self):
        with self.assertRaises(ValueError):
            bs.orient_pair('X', '2.3.4', 'Y', '1.3.5')

    def test_invert_keeps_requested_orientation(self):
        # Same wire bucket, both orientations: inverted price == 1/straight.
        row = {'key': {'open': '2026-01-01T00:00:00'},
               'open_base': 100000, 'open_quote': 250,
               'high_base': 100000, 'high_quote': 260,
               'low_base': 100000, 'low_quote': 240,
               'close_base': 100000, 'close_quote': 255,
               'base_volume': 100000, 'quote_volume': 250}
        straight = bs.bucket_row_to_candle(row, 5, 2, invert=False)
        flipped = bs.bucket_row_to_candle(row, 5, 2, invert=True)
        self.assertAlmostEqual(straight['o'], 2.5)
        self.assertAlmostEqual(flipped['o'], 1 / 2.5)
        # Reciprocation reverses order: inverted high == 1/straight low.
        self.assertAlmostEqual(flipped['h'], 1 / 2.4)
        self.assertAlmostEqual(flipped['l'], 1 / 2.6)
        self.assertGreater(flipped['h'], flipped['l'])

    def test_pool_id_validation(self):
        self.assertEqual(bs.parse_pool_id('1.19.5'), 5)
        for bad in ('1.3.5', '1.19.x', '', None, 'abc'):
            with self.assertRaises(ValueError, msg=repr(bad)):
                bs.parse_pool_id(bad)


class TestBucketCandles(unittest.TestCase):
    def test_row_conversion(self):
        row = {'key': {'open': '2026-01-01T00:00:00'},
               'open_base': 100000, 'open_quote': 250,
               'high_base': 100000, 'high_quote': 300,
               'low_base': 100000, 'low_quote': 200,
               'close_base': 200000, 'close_quote': 500,
               'base_volume': 200000, 'quote_volume': 500}
        cd = bs.bucket_row_to_candle(row, 5, 2)
        self.assertEqual(cd['t'], 1767225600000)
        self.assertAlmostEqual(cd['o'], 2.5)
        self.assertAlmostEqual(cd['h'], 3.0)
        self.assertAlmostEqual(cd['l'], 2.0)
        self.assertAlmostEqual(cd['c'], 2.5)
        self.assertAlmostEqual(cd['v'], 2.0)

    def test_empty_bucket_is_none(self):
        row = {'key': {'open': '2026-01-01T00:00:00'},
               'open_base': 0, 'open_quote': 0, 'high_base': 0,
               'high_quote': 0, 'low_base': 0, 'low_quote': 0,
               'close_base': 0, 'close_quote': 0,
               'base_volume': 0, 'quote_volume': 0}
        self.assertIsNone(bs.bucket_row_to_candle(row, 5, 2))

    def test_merge_sort_dedupe_gapfill(self):
        t0, step = 1767225600000, 60000
        rows = [
            {'t': t0 + 2 * step, 'o': 3, 'h': 3, 'l': 3, 'c': 3, 'v': 1},
            {'t': t0, 'o': 1, 'h': 2, 'l': 1, 'c': 2, 'v': 5},
            {'t': t0, 'o': 9, 'h': 9, 'l': 9, 'c': 9, 'v': 9},  # dupe: wins
        ]
        out = bs.merge_candles(rows, 60)
        self.assertEqual([c['t'] for c in out],
                         [t0, t0 + step, t0 + 2 * step])
        self.assertEqual(out[0]['c'], 9)  # last write wins
        gap = out[1]
        self.assertEqual(
            (gap['o'], gap['h'], gap['l'], gap['c'], gap['v']),
            (9.0, 9.0, 9.0, 9.0, 0.0))  # prev-close interp

    def test_merge_limit_keeps_tail(self):
        rows = [{'t': 1000 * i, 'o': 1, 'h': 1, 'l': 1, 'c': i, 'v': 0}
                for i in range(1, 6)]
        out = bs.merge_candles(rows, 1, limit=2)
        self.assertEqual([c['c'] for c in out], [4.0, 5.0])

    def test_chunk_ranges_cap_200(self):
        chunks = bs.chunk_ranges(0, 300 * 60 * 1000, 60)
        self.assertEqual(len(chunks), 2)  # 200 + 100 slots
        self.assertEqual(chunks[0][0], '1970-01-01T00:00:00')
        with self.assertRaises(ValueError):
            bs.chunk_ranges(10, 10, 60)


class TestBook(unittest.TestCase):
    def test_string_and_int_legs_agree(self):
        raw = {'bids': [{'base': '100000', 'quote': '250'}],
               'asks': [{'base': 100000, 'quote': 300}]}
        d = bs.book_to_depth(raw, 5, 2)
        self.assertAlmostEqual(d['bids'][0][0], 2.5)
        self.assertAlmostEqual(d['asks'][0][0], 3.0)
        self.assertAlmostEqual(d['bids'][0][1], 1.0)

    def test_sort_best_first(self):
        raw = {'bids': [{'base': 100000, 'quote': 200},
                        {'base': 100000, 'quote': 250}],
               'asks': [{'base': 100000, 'quote': 300},
                        {'base': 100000, 'quote': 280}]}
        d = bs.book_to_depth(raw, 5, 2)
        self.assertGreater(d['bids'][0][0], d['bids'][1][0])
        self.assertLess(d['asks'][0][0], d['asks'][1][0])

    def test_limit_clamped_to_50(self):
        raw = {'bids': [{'base': 100000, 'quote': 200 + i} for i in range(60)],
               'asks': []}
        self.assertEqual(len(bs.book_to_depth(raw, 5, 2, 999)['bids']), 50)
        self.assertEqual(len(bs.book_to_depth(raw, 5, 2, 3)['bids']), 3)
        self.assertEqual(bs.clamp_depth_limit(0), 1)
        self.assertEqual(bs.clamp_depth_limit(-7), 1)

    def test_dust_skipped(self):
        raw = {'bids': [{'base': 0, 'quote': 5},
                        {'base': 'nope', 'quote': '5'}],
               'asks': []}
        self.assertEqual(bs.book_to_depth(raw, 5, 2)['bids'], [])

    def test_fill_limit_clamped_to_101(self):
        self.assertEqual(bs.clamp_fill_limit(9999), 101)
        self.assertEqual(bs.clamp_fill_limit(0), 1)
        self.assertEqual(bs.clamp_fill_limit(50), 50)


class TestQuoteFeeds(unittest.TestCase):
    def test_ticker_join(self):
        ticker = {'base': 100000, 'quote': 250, 'highest_bid': 2.4,
                  'lowest_ask': 2.6, 'base_volume': 200000,
                  'percent_change': 5.0}
        q = bs.ticker_to_quote(ticker, 5, 2)
        self.assertAlmostEqual(q['price'], 2.5)
        self.assertAlmostEqual(q['bid'], 2.4)
        self.assertAlmostEqual(q['ask'], 2.6)
        self.assertAlmostEqual(q['volume'], 2.0)
        self.assertAlmostEqual(q['change24h'], 0.05)

    def test_ticker_string_float_shape(self):
        # Modern nodes return latest/bid/ask as decimal floats and base/quote
        # as asset-id strings (no satoshi legs to ratio).
        ticker = {'base': '1.3.0', 'quote': '1.3.121', 'latest': '2.5',
                  'highest_bid': '2.4', 'lowest_ask': '2.6',
                  'base_volume': '200000', 'percent_change': '5.0'}
        q = bs.ticker_to_quote(ticker, 5, 2)
        self.assertAlmostEqual(q['price'], 2.5)
        self.assertAlmostEqual(q['bid'], 2.4)
        self.assertAlmostEqual(q['ask'], 2.6)

    def test_book_price_leg_fallback(self):
        raw = {'bids': [{'price': 2.5, 'quote': '250'}], 'asks': []}
        d = bs.book_to_depth(raw, 5, 2)
        self.assertAlmostEqual(d['bids'][0][0], 2.5)
        self.assertAlmostEqual(d['bids'][0][1], 1.0)

    def test_ticker_drops_empty_optionals(self):
        q = bs.ticker_to_quote({'base': 0, 'quote': 0,
                                'highest_bid': 0, 'lowest_ask': -1}, 5, 2)
        self.assertNotIn('price', q)
        self.assertNotIn('bid', q)
        self.assertNotIn('ask', q)

    def test_feed_age_and_expiry(self):
        now = 1767225600
        self.assertEqual(bs.feed_age_s('2026-01-01T00:00:00', now=now), 0)
        self.assertEqual(bs.feed_age_s(1767225600 - 3600, now=now), 3600)
        self.assertFalse(bs.is_feed_expired('2026-01-01T00:00:00', now=now))
        self.assertTrue(bs.is_feed_expired('2025-12-30T00:00:00', now=now))
        # Boundary: exactly the lifetime is fresh; one second past is stale.
        self.assertFalse(bs.is_feed_expired(now - 86400, now=now))
        self.assertTrue(bs.is_feed_expired(now - 86401, now=now))
        self.assertTrue(bs.is_feed_expired(None, now=now))

    def test_bitasset_reduce(self):
        bitasset = {
            'current_feed': {
                'settlement_price': {'base': 100000, 'quote': 250},
                'core_exchange_rate': {'base': 100000, 'quote': 240},
                'maximum_short_squeeze_ratio': 1100,
                'maintenance_collateral_ratio': 1750,
            },
            'current_feed_publication_time': '2026-01-01T00:00:00',
        }
        f = bs.bitasset_to_feeds(bitasset, 5, 2, now=1767225600 + 60)
        self.assertAlmostEqual(f['settlement_price'], 2.5)
        self.assertAlmostEqual(f['cer'], 2.4)
        self.assertAlmostEqual(f['mssr'], 1.1)
        self.assertAlmostEqual(f['mcr'], 1.75)
        self.assertEqual(f['feed_age_s'], 60)
        self.assertFalse(f['expired'])

    def test_bitasset_missing_is_expired(self):
        f = bs.bitasset_to_feeds({}, now=1767225600)
        self.assertIsNone(f['settlement_price'])
        self.assertTrue(f['expired'])

    def test_quote_carries_settlement_age_and_expiry_flag(self):
        ticker = {'base': 100000, 'quote': 250, 'base_volume': 100000}
        bitasset = {
            'current_feed': {
                'settlement_price': {'base': 100000, 'quote': 260}},
            'current_feed_publication_time': '2026-01-01T00:00:00',
        }
        q = bs.ticker_to_quote(ticker, 5, 2, bitasset=bitasset,
                               now=1767225600 + 10)
        self.assertAlmostEqual(q['settlement_price'], 2.6)
        self.assertEqual(q['feed_age_s'], 10)
        self.assertIn('feed_expired', q)
        self.assertFalse(q['feed_expired'])

    def test_quote_flags_stale_feed(self):
        ticker = {'base': 100000, 'quote': 250, 'base_volume': 100000}
        bitasset = {
            'current_feed': {
                'settlement_price': {'base': 100000, 'quote': 260}},
            'current_feed_publication_time': '2025-12-20T00:00:00',
        }
        q = bs.ticker_to_quote(ticker, 5, 2, bitasset=bitasset,
                               now=1767225600)
        self.assertTrue(q['feed_expired'])
        self.assertTrue(q['expired'])


# ---------------------------------------------------------------------------
# ES body builder + paging budget
# ---------------------------------------------------------------------------

class TestESBuilder(unittest.TestCase):
    def test_default_is_op63_match(self):
        body = bs.build_es_body('2026-01-01T00:00:00', '2026-01-02T00:00:00')
        must = body['query']['bool']['must']
        self.assertIn({'match': {'operation_type': 63}}, must)
        ranges = [c['range'] for c in must if 'range' in c]
        self.assertEqual(ranges[0]['block_data.block_time'],
                         {'gte': '2026-01-01T00:00:00',
                          'lte': '2026-01-02T00:00:00'})
        self.assertEqual(body['size'], 10000)

    def test_desc_sort(self):
        body = bs.build_es_body()
        self.assertEqual(body['sort'],
                         [{'block_data.block_time': 'desc'},
                          {'operation_id': 'desc'}])

    def test_pool_id_uses_multi_match(self):
        body = bs.build_es_body(pool_id='1.19.5')
        must = body['query']['bool']['must']
        mm = [c['multi_match'] for c in must if 'multi_match' in c]
        self.assertEqual(len(mm), 1)
        self.assertEqual(mm[0]['query'], '1.19.5')
        self.assertTrue(len(mm[0]['fields']) >= 1)

    def test_op4_isolated_on_request(self):
        body = bs.build_es_body(op_types=(4,))
        must = body['query']['bool']['must']
        self.assertIn({'match': {'operation_type': 4}}, must)

    def test_filters_and_search_after(self):
        body = bs.build_es_body(pool_id='1.19.5', account='1.2.3',
                                search_after=['2026-01-01T00:00:00', '1.11.1'])
        must = body['query']['bool']['must']
        self.assertIn({'term': {'account': '1.2.3'}}, must)
        self.assertEqual(body['search_after'],
                         ['2026-01-01T00:00:00', '1.11.1'])
        self.assertEqual(len(body['sort']), 2)

    def test_paging_budget(self):
        self.assertEqual(bs.ES_PAGE_SIZE, 10000)
        self.assertEqual(bs.ES_MAX_PAGES, 8)
        self.assertEqual(bs.ES_URL,
                         'https://es.bitshares.dev/bitshares-*/_search')
        self.assertEqual(bs.ES_TIME_BUDGET_S, 60.0)
        body = bs.build_es_body(size=50000)
        self.assertEqual(body['size'], 10000)  # clamped to one page

    def test_search_after_helper(self):
        hit = {'sort': ['2026-01-01T00:00:00', '1.11.9'],
               '_source': {'block_data': {'block_time': '2026-01-01T00:00:00'}}}
        self.assertEqual(bs.es_search_after_for(hit),
                         ['2026-01-01T00:00:00', '1.11.9'])
        synth = _es_hit(sort=None)
        cur = bs.es_search_after_for(synth)
        self.assertEqual(cur, ['2026-01-01T00:00:00', '1.11.1'])

    def test_paging_short_page_stops_uncapped(self):
        calls = []

        def fake_post(body):
            calls.append(body)
            return {'hits': {'hits': [_es_hit()]}}

        old = bs.ES_PAGE_SIZE
        bs.ES_PAGE_SIZE = 10
        try:
            res = bs.es_pool_history('1.19.5', _post=fake_post)
        finally:
            bs.ES_PAGE_SIZE = old
        self.assertEqual(res['pages'], 1)
        self.assertEqual(len(res['hits']), 1)
        self.assertFalse(res['capped'])

    def test_paging_full_pages_sets_capped(self):
        old = bs.ES_PAGE_SIZE
        bs.ES_PAGE_SIZE = 2
        try:
            def fake_post(body):
                hits = [_es_hit(block_time='2026-01-0%dT00:00:00' % (i + 1,),
                                sort=['2026-01-0%dT00:00:00' % (i + 1,),
                                      '1.11.%d' % i])
                        for i in range(2)]
                return {'hits': {'hits': hits}}

            res = bs.es_pool_history('1.19.5', max_pages=2, _post=fake_post)
        finally:
            bs.ES_PAGE_SIZE = old
        self.assertEqual(res['pages'], 2)
        self.assertEqual(len(res['hits']), 4)
        self.assertTrue(res['capped'])  # page budget exhausted on full pages

    def test_paging_transport_error_carries_reason(self):
        def boom(body):
            raise TimeoutError('down')

        with self.assertRaises(Exception) as ctx:
            bs.es_pool_history('1.19.5', _post=boom)
        self.assertIn('bitshares:', str(ctx.exception))


# ---------------------------------------------------------------------------
# ES swap parsing + bucketing (POOL only)
# ---------------------------------------------------------------------------

class TestESSwaps(unittest.TestCase):
    def test_pool_record_gate(self):
        self.assertTrue(bs.es_is_pool_record(_es_hit(op_type=63)))
        self.assertFalse(bs.es_is_pool_record(_es_hit(op_type=4)))
        self.assertFalse(bs.es_is_pool_record({}))

    def test_block_time_ms(self):
        hit = _es_hit(block_time='2026-01-01T00:00:00')
        self.assertEqual(bs.es_hit_block_time_ms(hit), 1767225600000)
        self.assertIsNone(bs.es_hit_block_time_ms({}))

    def test_extract_swap_paid_received(self):
        swap = bs.es_extract_swap(_es_hit())
        self.assertEqual(swap['t_ms'], 1767225600000)
        self.assertEqual(swap['pool'], '1.19.5')
        self.assertEqual(swap['paid'], {'asset': '1.3.0', 'amount': 100000})
        self.assertEqual(swap['received'],
                         {'asset': '1.3.121', 'amount': 250})

    def test_extract_rejects_op4_and_bad_legs(self):
        self.assertIsNone(bs.es_extract_swap(_es_hit(op_type=4)))
        bad = _es_hit(paid=('1.3.0', 0), received=('1.3.121', 250))
        self.assertIsNone(bs.es_extract_swap(bad))
        self.assertIsNone(bs.es_extract_swap({'_source': {'operation_type': 63}}))

    def test_extract_list_result_shape(self):
        hit = {'_source': {
            'operation_type': 63,
            'operation_id': '1.11.2',
            'block_data': {'block_time': '2026-01-01T00:01:00'},
            'pool_id': '1.19.5',
            'operation_result': [{'asset_id': '1.3.0', 'amount': 100000},
                                 {'asset_id': '1.3.121', 'amount': 250}],
        }}
        swap = bs.es_extract_swap(hit)
        self.assertIsNotNone(swap)
        self.assertEqual(swap['pool'], '1.19.5')

    def test_swap_price_both_directions(self):
        # Pays BASE, receives QUOTE: 1.0 BTS -> 2.5 bitUSD.
        swap = {'paid': {'asset': '1.3.0', 'amount': 100000},
                'received': {'asset': '1.3.121', 'amount': 250}}
        price, vol = bs.es_swap_price(swap, '1.3.0', '1.3.121', 5, 2)
        self.assertAlmostEqual(price, 2.5)
        self.assertAlmostEqual(vol, 1.0)
        # Reverse direction prices identically (oriented, never silent).
        rev = {'paid': {'asset': '1.3.121', 'amount': 250},
               'received': {'asset': '1.3.0', 'amount': 100000}}
        price2, vol2 = bs.es_swap_price(rev, '1.3.0', '1.3.121', 5, 2)
        self.assertAlmostEqual(price2, 2.5)
        self.assertAlmostEqual(vol2, 1.0)

    def test_swap_price_mismatch_is_none(self):
        swap = {'paid': {'asset': '1.3.0', 'amount': 100000},
                'received': {'asset': '1.3.999', 'amount': 250}}
        self.assertEqual(
            bs.es_swap_price(swap, '1.3.0', '1.3.121', 5, 2), (None, None))

    def test_swaps_to_candles_floor_bucketing(self):
        t0 = 1767225600000  # 2026-01-01T00:00:00Z
        hits = [
            _es_hit(block_time='2026-01-01T00:00:10',
                    paid=('1.3.0', 100000), received=('1.3.121', 250)),
            _es_hit(block_time='2026-01-01T00:00:50',
                    paid=('1.3.0', 100000), received=('1.3.121', 300)),
            _es_hit(block_time='2026-01-01T00:01:05',
                    paid=('1.3.0', 200000), received=('1.3.121', 500)),
            _es_hit(op_type=4),  # order-book fill: POOL path must skip it
        ]
        out = bs.es_swaps_to_candles(hits, '1.3.0', '1.3.121', 5, 2, 60)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]['t'], t0)
        self.assertAlmostEqual(out[0]['o'], 2.5)
        self.assertAlmostEqual(out[0]['h'], 3.0)
        self.assertAlmostEqual(out[0]['l'], 2.5)
        self.assertAlmostEqual(out[0]['c'], 3.0)
        self.assertAlmostEqual(out[0]['v'], 2.0)
        self.assertEqual(out[1]['t'], t0 + 60000)

    def test_pool_candles_needs_valid_pool_and_nonempty(self):
        with self.assertRaises(ValueError):
            bs.pool_candles('1.3.5', '1.3.0', '1.3.121', 5, 2, '1m',
                            _post=lambda b: {'hits': {'hits': []}})
        with self.assertRaises(Exception) as ctx:
            bs.pool_candles('1.19.5', '1.3.0', '1.3.121', 5, 2, '1m',
                            _post=lambda b: {'hits': {'hits': []}})
        self.assertIn('bitshares:', str(ctx.exception))

    def test_pool_candles_merges_with_gap_fill(self):
        t0_iso = '2026-01-01T00:00:10'
        t2_iso = '2026-01-01T00:02:10'

        def fake_post(body):
            return {'hits': {'hits': [
                _es_hit(block_time=t0_iso, paid=('1.3.0', 100000),
                        received=('1.3.121', 250)),
                _es_hit(block_time=t2_iso, paid=('1.3.0', 100000),
                        received=('1.3.121', 260)),
            ]}}

        out = bs.pool_candles('1.19.5', '1.3.0', '1.3.121', 5, 2, '1m',
                              limit=10, _post=fake_post)
        self.assertEqual(len(out), 3)  # middle bucket prev-close filled
        self.assertEqual(out[1]['v'], 0.0)
        self.assertAlmostEqual(out[1]['c'], 2.5)


# ---------------------------------------------------------------------------
# XBTS REST fallback (order-book daily only)
# ---------------------------------------------------------------------------

class TestXBTS(unittest.TestCase):
    def test_url_shape(self):
        url = bs.build_xbts_history_url('bts', 'bitusd', '1d', 300)
        self.assertTrue(url.startswith(bs.XBTS_REST_BASE + '/v2/history?'))
        self.assertIn('base=BTS', url)
        self.assertIn('quote=BITUSD', url)
        self.assertIn(bs.XBTS_REST_BASE, 'https://market-api-v2.xbts.io')

    def test_parse_list_and_wrapper(self):
        rows = [{'t': 1767225600000, 'o': 1, 'h': 2, 'l': 0.5,
                 'c': 1.5, 'v': 10}]
        self.assertEqual(len(bs.xbts_parse_history(rows)), 1)
        wrapped = {'data': rows}
        self.assertEqual(len(bs.xbts_parse_history(wrapped)), 1)
        iso_rows = [{'time': '2026-01-01T00:00:00', 'open': 1, 'high': 1,
                     'low': 1, 'close': 1, 'volume': 1}]
        parsed = bs.xbts_parse_history(iso_rows)
        self.assertEqual(parsed[0]['t'], 1767225600000)
        # Bad rows skipped, never crash.
        mixed = rows + [{'oops': True}, 'nope']
        self.assertEqual(len(bs.xbts_parse_history(mixed)), 1)

    def test_parse_sorts_and_dedupes(self):
        t0 = 1767225600000
        rows = [
            {'t': t0 + 2000, 'o': 2, 'h': 2, 'l': 2, 'c': 2, 'v': 1},
            {'t': t0, 'o': 1, 'h': 1, 'l': 1, 'c': 1, 'v': 1},
            {'t': t0, 'o': 9, 'h': 9, 'l': 9, 'c': 9, 'v': 9},
        ]
        out = bs.xbts_parse_history(rows)
        self.assertEqual([r['t'] for r in out], [t0, t0 + 2000])
        self.assertEqual(out[0]['c'], 9.0)

    def test_fetch_daily_with_fake_get(self):
        rows = [{'t': 1767225600000, 'o': 1, 'h': 1, 'l': 1, 'c': 1, 'v': 5}]
        out = bs.xbts_fetch_daily('BTS', 'bitUSD', _get=lambda url: rows)
        self.assertEqual(len(out), 1)

    def test_fetch_daily_empty_and_error_carry_reason(self):
        with self.assertRaises(Exception) as ctx:
            bs.xbts_fetch_daily('BTS', 'bitUSD', _get=lambda url: [])
        self.assertIn('bitshares:', str(ctx.exception))

        def boom(url):
            raise TimeoutError('down')

        with self.assertRaises(Exception) as ctx2:
            bs.xbts_fetch_daily('BTS', 'bitUSD', _get=boom)
        self.assertIn('bitshares:', str(ctx2.exception))


# ---------------------------------------------------------------------------
# Fill history (WS-native, order-book only)
# ---------------------------------------------------------------------------

class TestFills(unittest.TestCase):
    def test_row_to_trade(self):
        row = {'time': '2026-01-01T00:00:00',
               'pays': {'asset_id': '1.3.0', 'amount': 100000},
               'receives': {'asset_id': '1.3.121', 'amount': 250}}
        trade = bs.fill_row_to_trade(row, 5, 2)
        self.assertEqual(trade['t'], 1767225600000)
        self.assertAlmostEqual(trade['p'], 2.5)
        self.assertAlmostEqual(trade['a'], 1.0)

    def test_row_invert(self):
        row = {'time': '2026-01-01T00:00:00',
               'pays': {'asset_id': '1.3.0', 'amount': 100000},
               'receives': {'asset_id': '1.3.121', 'amount': 250}}
        straight = bs.fill_row_to_trade(row, 5, 2, invert=False)
        flipped = bs.fill_row_to_trade(row, 5, 2, invert=True)
        self.assertAlmostEqual(flipped['p'], 1 / straight['p'])

    def test_row_bad_is_none(self):
        self.assertIsNone(bs.fill_row_to_trade({}, 5, 2))
        self.assertIsNone(bs.fill_row_to_trade({'time': '2026-01-01T00:00:00',
                                                'pays': {'asset_id': '1.3.0',
                                                          'amount': 0},
                                                'receives': {'asset_id': '1.3.121',
                                                             'amount': 5}}, 5, 2))

    def test_latency_sort_sinks_failures(self):
        def fake_latency(url, timeout=5):
            if 'good' in url:
                return 10.0
            raise OSError('down')

        orig = bs.tcp_latency_ms
        bs.tcp_latency_ms = fake_latency
        try:
            out = bs.sort_nodes_by_latency(['wss://bad/x', 'wss://good/x'])
        finally:
            bs.tcp_latency_ms = orig
        self.assertEqual(out, ['wss://good/x', 'wss://bad/x'])


# ---------------------------------------------------------------------------
# Live-routing fixes (verified 2026-10-15, offline doubles)
# ---------------------------------------------------------------------------

class TestHistoryRouting(unittest.TestCase):
    def test_probe_prefers_hist_api(self):
        node = FakeNode(
            db_map={'get_market_history_buckets': lambda p: (_ for _ in ()).throw(
                Exception('Method not found'))},
            hist_map={'get_market_history_buckets': lambda p: [60, 3600]},
            hist_api=2)
        self.assertEqual(bs.probe_history_buckets(node), [60, 3600])

    def test_probe_falls_back_to_db(self):
        node = FakeNode(
            db_map={'get_market_history_buckets': lambda p: [60]},
            hist_map={},
            hist_api=None)
        # hist_api None -> hist() raises; db serves.
        self.assertEqual(bs.probe_history_buckets(node), [60])

    def test_probe_raises_with_reason_when_both_missing(self):
        node = FakeNode(db_map={}, hist_map={}, hist_api=2)
        with self.assertRaises(Exception) as ctx:
            bs.probe_history_buckets(node)
        self.assertIn('bitshares:', str(ctx.exception))

    def test_fetch_market_history_prefers_hist(self):
        node = FakeNode(
            db_map={'get_market_history': lambda p: (_ for _ in ()).throw(
                Exception('Method not found'))},
            hist_map={'get_market_history': lambda p: [{'ok': 1}]},
            hist_api=7)
        out = bs.fetch_market_history(node, '1.3.0', '1.3.121', 60,
                                      '2026-01-01T00:00:00',
                                      '2026-01-02T00:00:00')
        self.assertEqual(out, [{'ok': 1}])
        kinds = [c[0] for c in node.calls]
        self.assertIn('hist', kinds)


class TestLiveBookShapes(unittest.TestCase):
    def test_decimal_human_legs(self):
        # Live get_order_book shape (node.xbts.io 2026-10-15): decimal
        # human units, price = base/quote market convention. Contract wants
        # QUOTE per BASE, so 1.7082 USD / 116.19821 BTS ~= 0.0147.
        raw = {'bids': [{'price': '68.02377356281465870506',
                         'quote': '1.7082', 'base': '116.19821'}],
               'asks': []}
        d = bs.book_to_depth(raw, 5, 4)
        self.assertEqual(len(d['bids']), 1)
        self.assertAlmostEqual(d['bids'][0][0], 1.7082 / 116.19821, places=6)
        self.assertAlmostEqual(d['bids'][0][1], 116.19821, places=5)

    def test_ticker_decimal_volume(self):
        ticker = {'base': '1.3.0', 'quote': '1.3.121', 'latest': '68.7',
                  'highest_bid': '68.0', 'lowest_ask': '74.0',
                  'base_volume': '116.19821', 'percent_change': '0'}
        q = bs.ticker_to_quote(ticker, 5, 4)
        self.assertAlmostEqual(q['price'], 68.7)
        self.assertAlmostEqual(q['volume'], 116.19821)

    def test_bitasset_nested_feeds_shape(self):
        # Live get_objects shape: feeds[i] = [account, [pub_time, feed]].
        bitasset = {
            'feeds': [['1.2.4952', ['2026-01-01T00:00:00', {
                'settlement_price': {'base': 100000, 'quote': 250},
                'maximum_short_squeeze_ratio': 1100,
                'maintenance_collateral_ratio': 1750,
            }]]],
        }
        f = bs.bitasset_to_feeds(bitasset, 5, 2, now=1767225600 + 30)
        self.assertAlmostEqual(f['settlement_price'], 2.5)
        self.assertEqual(f['feed_age_s'], 30)
        self.assertFalse(f['expired'])

    def test_get_bitasset_falls_back_to_objects(self):
        def fail_db(method, params):
            if method == 'get_bitasset_data':
                raise Exception('Method not found')
            if method == 'get_objects':
                return [{'id': '2.4.21', 'current_feed': {
                    'settlement_price': {'base': 100000, 'quote': 250}},
                    'current_feed_publication_time': '2026-01-01T00:00:00'}]
            raise Exception('nope')

        class N(object):
            hist_api = None

            def db(self, method, params):
                return fail_db(method, params)

        data = bs.get_bitasset_data(N(), '2.4.21')
        self.assertIn('current_feed', data)

    def test_fetch_bitasset_resolves_24x(self):
        class N(object):
            hist_api = None

            def db(self, method, params):
                if method == 'get_bitasset_data':
                    raise Exception('Method not found')
                if method == 'get_objects' and params == [['1.3.121']]:
                    return [{'id': '1.3.121',
                             'bitasset_data_id': '2.4.21'}]
                if method == 'get_objects' and params == [['2.4.21']]:
                    return [{'id': '2.4.21', 'current_feed': {}}]
                raise Exception('nope %s' % method)

        data = bs.fetch_bitasset_for(N(), '1.3.121')
        self.assertEqual(data['id'], '2.4.21')

    def test_fetch_bitasset_none_when_not_bitasset(self):
        class N2(object):
            hist_api = None

            def db(self, method, params):
                if method == 'get_bitasset_data':
                    raise Exception('Method not found')
                if method == 'get_objects':
                    return [{'id': '1.3.0'}]  # no bitasset_data_id
                raise Exception('nope')

        self.assertIsNone(bs.fetch_bitasset_for(N2(), '1.3.0'))


# ---------------------------------------------------------------------------
# Symbols / validation (must raise before any network use)
# ---------------------------------------------------------------------------

class TestSymbols(unittest.TestCase):
    def test_parse_ok(self):
        self.assertEqual(bs.parse_symbol('bts:bitusd'), ('BTS', 'BITUSD'))
        self.assertEqual(bs.parse_symbol('BTS.BITUSD:USD'), ('BTS.BITUSD', 'USD'))

    def test_parse_rejects(self):
        for bad in ('BTS', 'A:B:C', '', ':USD', 'BTS:', 'BT S:USD',
                    'BTS/USD', 'x' * 33 + ':USD'):
            with self.assertRaises(ValueError, msg=repr(bad)):
                bs.parse_symbol(bad)

    def test_live_entrypoints_validate_before_network(self):
        # Offline proof: bad interval / symbol / venue raise without any
        # socket use (no pip package need exist at all).
        with self.assertRaises(ValueError):
            bs.candles('bitshares', 'BTS:bitUSD', '2h')
        with self.assertRaises(ValueError):
            bs.candles('bitshares', 'nope', '1m')
        with self.assertRaises(ValueError):
            bs.candles('nope', 'BTS:bitUSD', '1m')
        with self.assertRaises(ValueError):
            bs.depth('bitshares', 'BTS', 5)
        with self.assertRaises(ValueError):
            bs.quote('nope', 'BTS:bitUSD')

    def test_rpc_and_node_errors_carry_reason(self):
        sock = FakeSocket([_server_frame('not json')])
        ws = bs.RawWS(sock)
        with self.assertRaises(Exception) as ctx:
            bs._rpc(ws, 2, 'get_ticker', [], 1)
        self.assertIn('bitshares:', str(ctx.exception))

        sock2 = FakeSocket(
            [_server_frame('{"id":1,"error":{"message":"boom"}}')])
        ws2 = bs.RawWS(sock2)
        with self.assertRaises(Exception) as ctx2:
            bs._rpc(ws2, 2, 'get_ticker', [], 1)
        self.assertIn('bitshares:', str(ctx2.exception))


if __name__ == '__main__':
    unittest.main()

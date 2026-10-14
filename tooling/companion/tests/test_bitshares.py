"""Offline unit tests for the BitShares companion source (workstream F).

Stdlib ``unittest`` only. Fully offline: no network, no ``websocket-client``
(no import of it — the module degrades gracefully and these tests pin that).
Covers: interval validation, bucketing math, precision conversion
(incl. satoshi strings), pair-orientation rule, feed-expiry math, ES
query-body builder (+ paging budget), book normalisation (+ limit clamp),
gap-fill/merge/dedupe, symbol parsing, and the degraded-import contract.
"""

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

    def test_venues_single(self):
        self.assertEqual(bs.venues(),
                         [{'id': 'bitshares', 'label': 'BitShares DEX'}])

    def test_degraded_import(self):
        # Must import without websocket-client; helpers stay usable.
        st = bs.status()
        self.assertIn('ok', st)
        if not bs.WS_AVAILABLE:
            self.assertFalse(st['ok'])
            self.assertIn('websocket-client', st['reason'])
            self.assertIn('websocket-client', bs.INSTALL_HINT)
        else:
            self.assertTrue(st['ok'])


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

    def test_quote_carries_settlement_and_age(self):
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


class TestESBuilder(unittest.TestCase):
    def test_default_is_op63(self):
        body = bs.build_es_body('2026-01-01T00:00:00', '2026-01-02T00:00:00')
        must = body['query']['bool']['must']
        self.assertIn({'terms': {'operation_type': [63]}}, must)
        ranges = [c['range'] for c in must if 'range' in c]
        self.assertEqual(ranges[0]['block_data.block_time'],
                         {'gte': '2026-01-01T00:00:00',
                          'lte': '2026-01-02T00:00:00'})
        self.assertEqual(body['size'], 10000)

    def test_op4_isolated_on_request(self):
        body = bs.build_es_body(op_types=(4,))
        must = body['query']['bool']['must']
        self.assertIn({'terms': {'operation_type': [4]}}, must)

    def test_filters_and_search_after(self):
        body = bs.build_es_body(pool_id='1.19.5', account='1.2.3',
                                search_after=['2026-01-01T00:00:00', '1.11.1'])
        must = body['query']['bool']['must']
        self.assertIn({'term': {'pool_id': '1.19.5'}}, must)
        self.assertIn({'term': {'account': '1.2.3'}}, must)
        self.assertEqual(body['search_after'],
                         ['2026-01-01T00:00:00', '1.11.1'])
        self.assertEqual(len(body['sort']), 2)

    def test_paging_budget(self):
        self.assertEqual(bs.ES_PAGE_SIZE, 10000)
        self.assertEqual(bs.ES_MAX_PAGES, 8)
        self.assertEqual(bs.ES_URL,
                         'https://es.bitshares.dev/bitshares-*/_search')
        body = bs.build_es_body(size=50000)
        self.assertEqual(body['size'], 10000)  # clamped to one page


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
        # socket use (websocket-client need not even be installed).
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


if __name__ == '__main__':
    unittest.main()

"""Offline unit tests for tooling/companion/sources/dex.py (workstream E).

Fully offline: every test uses inline fixtures, no network. Live probes are
documented as notes only (see LIVE NOTES at the bottom) and never gate tests.
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_DEX_PATH = os.path.normpath(os.path.join(_HERE, '..', 'sources', 'dex.py'))


def _load():
    spec = importlib.util.spec_from_file_location('dex_source', _DEX_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


dex = _load()


class ContractTest(unittest.TestCase):
    def test_source_constants(self):
        self.assertEqual(dex.SOURCE, 'dex')
        self.assertEqual(dex.LABEL, 'DEX Pools')
        self.assertEqual(
            dex.INTERVALS,
            ['1m', '5m', '15m', '30m', '1h', '6h', '12h', '24h'],
        )
        self.assertEqual(
            dex.STREAM,
            {
                'mode': 'poll',
                'cadence': 60,
                'note': 'free-tier delay \u226460s; keyless OHLC 1h+/24h on DexPaprika',
            },
        )

    def test_interval_seconds(self):
        self.assertEqual(dex.interval_seconds('1m'), 60)
        self.assertEqual(dex.interval_seconds('1h'), 3600)
        self.assertEqual(dex.interval_seconds('24h'), 86400)
        with self.assertRaises(ValueError):
            dex.interval_seconds('10m')


class VenuesTest(unittest.TestCase):
    def test_static_venues(self):
        venues = dex.venues()
        self.assertEqual(len(venues), 36)
        ids = {v['id'] for v in venues}
        for expected in ('ethereum', 'solana', 'bsc', 'arbitrum', 'base'):
            self.assertIn(expected, ids)
        for v in venues:
            self.assertIn('id', v)
            self.assertIn('label', v)

    def test_refresh_venues_offline_fallback(self):
        # Unroutable host: must fall back to the static list, never raise.
        venues = dex.refresh_venues(base_url='http://127.0.0.1:9', timeout=1)
        self.assertEqual(len(venues), 36)


class PoolIdTest(unittest.TestCase):
    def test_evm_pool_id(self):
        net, addr = dex.parse_pool_id(
            'ethereum:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'
        )
        self.assertEqual(net, 'ethereum')
        self.assertTrue(addr.startswith('0x'))

    def test_solana_pool_id(self):
        net, addr = dex.parse_pool_id(
            'solana:6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN'
        )
        self.assertEqual(net, 'solana')
        self.assertEqual(addr, '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN')

    def test_rejects(self):
        bad = [
            '',
            'ethereum',
            'ethereum:',
            ':0x1234',
            'ETHEREUM:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
            'ethereum:88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',  # missing 0x
            'ethereum:0xZZZZ',  # non-hex
            'ethereum:0x123',  # too short
            'ethereum:0x88e6:extra',  # two colons
            'solana:short',  # base58 too short
            'solana:not valid!!',
        ]
        for symbol in bad:
            with self.subTest(symbol=symbol):
                with self.assertRaises(ValueError):
                    dex.parse_pool_id(symbol)


class IntervalMapTest(unittest.TestCase):
    def test_gecko_exact(self):
        self.assertEqual(dex.gecko_spec('1m'), ('minute', 1, 1))
        self.assertEqual(dex.gecko_spec('5m'), ('minute', 5, 1))
        self.assertEqual(dex.gecko_spec('15m'), ('minute', 15, 1))
        self.assertEqual(dex.gecko_spec('1h'), ('hour', 1, 1))
        self.assertEqual(dex.gecko_spec('12h'), ('hour', 12, 1))
        self.assertEqual(dex.gecko_spec('24h'), ('day', 1, 1))

    def test_gecko_resampled(self):
        # No exact Gecko aggregate: fetch finer and resample client-side.
        self.assertEqual(dex.gecko_spec('30m'), ('minute', 15, 2))
        self.assertEqual(dex.gecko_spec('6h'), ('hour', 1, 6))

    def test_gecko_unknown(self):
        with self.assertRaises(ValueError):
            dex.gecko_spec('10m')

    def test_url_builders(self):
        url = dex.build_dexpaprika_ohlcv_url('ethereum', '0xabc', 1700000000, '1h', 100)
        self.assertIn('/networks/ethereum/pools/0xabc/ohlcv', url)
        self.assertIn('interval=1h', url)
        self.assertIn('start=1700000000', url)
        url = dex.build_gecko_ohlcv_url('eth', '0xabc', 'hour', 1, limit=50)
        self.assertIn('/networks/eth/pools/0xabc/ohlcv/hour', url)
        self.assertIn('aggregate=1', url)


class ParseTest(unittest.TestCase):
    def test_iso_to_ms(self):
        import datetime

        want = int(
            datetime.datetime(2025, 3, 10, tzinfo=datetime.timezone.utc).timestamp()
            * 1000
        )
        self.assertEqual(dex.iso_to_ms('2025-03-10T00:00:00Z'), want)
        self.assertEqual(dex.iso_to_ms('2025-03-10T00:00:00.000Z'), want)
        with self.assertRaises(ValueError):
            dex.iso_to_ms('not-a-time')

    def test_parse_dexpaprika(self):
        payload = [
            {
                'time_open': '2025-03-10T00:00:00Z',
                'time_close': '2025-03-11T00:00:00Z',
                'open': 126.4,
                'high': 131.48,
                'low': 115.52,
                'close': 118.2,
                'volume': 262402654,
            },
            {
                'time_open': '2025-03-11T00:00:00Z',
                'time_close': '2025-03-12T00:00:00Z',
                'open': 118.2,
                'high': 120.0,
                'low': 110.1,
                'close': 119.9,
                'volume': 100,
            },
        ]
        rows = dex.parse_dexpaprika_ohlcv(payload)
        self.assertEqual(len(rows), 2)
        self.assertEqual(
            sorted(rows[0]), ['c', 'h', 'l', 'o', 't', 'v']
        )
        self.assertEqual(rows[0]['o'], 126.4)
        self.assertEqual(rows[0]['v'], 262402654.0)
        self.assertLess(rows[0]['t'], rows[1]['t'])
        self.assertEqual(rows[1]['t'] - rows[0]['t'], 86400 * 1000)

    def test_parse_dexpaprika_skips_bad_rows(self):
        rows = dex.parse_dexpaprika_ohlcv([{'open': 1}, None, 'x'])
        self.assertEqual(rows, [])

    def test_parse_gecko(self):
        payload = {
            'data': {
                'attributes': {
                    'ohlcv_list': [
                        [1679414400, 1500.5, 1525.75, 1495.25, 1510.0, 12.5],
                        [1679418000, 1510.0, 1520.0, 1505.0, 1515.0, 7.0],
                    ]
                }
            }
        }
        rows = dex.parse_gecko_ohlcv(payload)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['t'], 1679414400 * 1000)
        self.assertEqual(rows[0]['o'], 1500.5)
        self.assertEqual(rows[1]['v'], 7.0)

    def test_parse_gecko_empty(self):
        self.assertEqual(dex.parse_gecko_ohlcv({}), [])
        self.assertEqual(dex.parse_gecko_ohlcv({'data': {}}), [])


class MergeTest(unittest.TestCase):
    def _row(self, t, o=1.0, v=1.0):
        return {'t': t, 'o': o, 'h': o + 1, 'l': o - 1, 'c': o + 0.5, 'v': v}

    def test_merge_sorts_and_dedupes(self):
        page1 = [self._row(3000, o=3.0), self._row(1000, o=1.0)]
        page2 = [self._row(2000, o=2.0), self._row(3000, o=30.0, v=9.0)]
        merged, providers = dex.merge_candles(
            [('dexpaprika', page1), ('geckoterminal', page2)]
        )
        self.assertEqual([r['t'] for r in merged], [1000, 2000, 3000])
        # Later page wins on duplicate timestamps.
        self.assertEqual(merged[2]['o'], 30.0)
        self.assertEqual(merged[2]['v'], 9.0)
        self.assertEqual(providers, ['dexpaprika', 'geckoterminal'])

    def test_merge_skips_empty_pages_but_keeps_provider(self):
        merged, providers = dex.merge_candles(
            [('dexpaprika', []), ('geckoterminal', [self._row(1000)])]
        )
        self.assertEqual(len(merged), 1)
        self.assertEqual(providers, ['geckoterminal'])

    def test_merge_empty(self):
        merged, providers = dex.merge_candles([])
        self.assertEqual((merged, providers), ([], []))

    def test_resample(self):
        rows = [self._row(t * 1000, o=float(t), v=10.0) for t in (1, 2, 3)]
        out = dex.resample_candles(rows, 2)
        self.assertEqual(len(out), 1)  # incomplete tail group dropped
        self.assertEqual(out[0]['t'], 1000)
        self.assertEqual(out[0]['o'], 1.0)
        self.assertEqual(out[0]['h'], 3.0)
        self.assertEqual(out[0]['l'], 0.0)
        self.assertEqual(out[0]['c'], 2.5)
        self.assertEqual(out[0]['v'], 20.0)

    def test_resample_exact_groups(self):
        rows = [self._row(t * 1000, o=float(t), v=1.0) for t in range(1, 7)]
        out = dex.resample_candles(rows, 6)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['v'], 6.0)


class FallbackTest(unittest.TestCase):
    def test_budget_statuses_fall_back(self):
        for status in (402, 403, 429):
            with self.subTest(status=status):
                self.assertEqual(
                    dex.fallback_plan(status, '1h', short=False),
                    ['geckoterminal'],
                )

    def test_shortfall_backfills(self):
        self.assertEqual(
            dex.fallback_plan(200, '24h', short=True), ['geckoterminal']
        )

    def test_full_page_needs_no_fallback(self):
        self.assertEqual(dex.fallback_plan(200, '1h', short=False), [])

    def test_not_found_still_tries_gecko(self):
        self.assertEqual(
            dex.fallback_plan(404, '1h', short=False), ['geckoterminal']
        )

    def test_gecko_network_translation(self):
        self.assertEqual(dex.gecko_network('ethereum'), 'eth')
        self.assertEqual(dex.gecko_network('solana'), 'solana')
        self.assertEqual(dex.gecko_network('obscure_chain'), 'obscure_chain')


class BudgetTest(unittest.TestCase):
    def test_402_maps(self):
        err = dex.budget_error(
            402,
            {
                'error': 'payment_required',
                'tier': 'keyless',
                'message': 'Credit limit reached. Register for a free API key.',
                'credits': {'limit': 10000, 'used': 10000, 'remaining': 0},
            },
        )
        self.assertIsInstance(err, dex.BudgetError)
        self.assertIsInstance(err, Exception)
        text = str(err)
        self.assertIn('402', text)
        self.assertIn('Credit limit reached', text)
        self.assertIn('dexpaprika', text.lower())

    def test_429_maps_with_retry(self):
        err = dex.budget_error(
            429,
            {'error': 'rate_limited', 'tier': 'keyless', 'retry_after': 12},
        )
        self.assertIsInstance(err, dex.BudgetError)
        self.assertIn('12', str(err))

    def test_403_plan_gate_names_tier(self):
        err = dex.budget_error(
            403,
            {
                'error': 'plan_required',
                'tier': 'keyless',
                'required_tier': 'free',
                'param': 'interval',
                'message': 'OHLCV intervals below 1h require an API key',
            },
        )
        self.assertIsInstance(err, dex.BudgetError)
        self.assertIn('free', str(err))
        self.assertIn('interval', str(err))

    def test_non_budget_returns_none(self):
        self.assertIsNone(dex.budget_error(404, {'error': 'not_found'}))
        self.assertIsNone(dex.budget_error(500, 'boom'))


class SearchParseTest(unittest.TestCase):
    def test_pool_search(self):
        payload = {
            'results': [
                {
                    'address': '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
                    'dex_name': 'uniswap_v3',
                    'token0_symbol': 'USDC',
                    'token1_symbol': 'WETH',
                    'liquidity_usd': 150000000,
                },
                {'dex_name': 'no-address-pool'},
            ]
        }
        out = dex.parse_pool_search(payload, 'ethereum')
        self.assertEqual(len(out), 1)
        self.assertEqual(
            out[0]['symbol'],
            'ethereum:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        )
        self.assertIn('USDC/WETH', out[0]['name'])
        self.assertIn('uniswap_v3', out[0]['name'])

    def test_pool_search_live_shape(self):
        # Real per-network shape: pool id in `id`, token entries often
        # carry no symbols — the label must still identify the pool.
        payload = {
            'results': [
                {
                    'id': '0x3b1b1f2e775a6db1664f8e7d59ad568605ea2406312c11aef03146c0cf89d5b9',
                    'chain': 'ethereum',
                    'dex_name': 'Uniswap V4',
                    'tokens': [
                        {'id': '0xdac17f958d2ee523a2206206994597c13d831ec7'},
                        {'id': '0xdc035d45d973e3ec169d2276ddab16f1e407384f'},
                    ],
                    'liquidity_usd': 49974928.86,
                }
            ]
        }
        out = dex.parse_pool_search(payload, 'ethereum')
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]['symbol'].startswith('ethereum:0x3b1b'))
        self.assertIn('0x3b1b', out[0]['name'])
        self.assertIn('Uniswap V4', out[0]['name'])

    def test_pool_search_list_payload(self):
        out = dex.parse_pool_search(
            [{'address': '0xabc', 'name': 'A / B'}], 'base'
        )
        self.assertEqual(out[0]['symbol'], 'base:0xabc')

    def test_global_search(self):
        payload = {
            'results': [
                {
                    'address': '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
                    'chain': 'ethereum',
                    'token0_symbol': 'USDC',
                    'token1_symbol': 'WETH',
                },
                {'symbol': 'TRUMP', 'chain': 'solana'},  # token hit: no pool
            ]
        }
        out = dex.parse_global_search(payload)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]['symbol'].startswith('ethereum:0x'))

    def test_global_search_live_shape(self):
        # Real global shape: {tokens, pools, dexes}; pool id in `id`,
        # network in `chain`, symbols nested in `tokens`.
        payload = {
            'tokens': [],
            'dexes': [],
            'pools': [
                {
                    'id': '0x2904ac7ceec2c54a58a7e65f5a9366b599205dec',
                    'chain': 'bsc',
                    'dex_name': 'PancakeSwap V2',
                    'tokens': [
                        {'symbol': 'WBNB'},
                        {'symbol': 'TRUMP'},
                    ],
                }
            ],
        }
        out = dex.parse_global_search(payload)
        self.assertEqual(len(out), 1)
        self.assertEqual(
            out[0]['symbol'],
            'bsc:0x2904ac7ceec2c54a58a7e65f5a9366b599205dec',
        )
        self.assertIn('WBNB/TRUMP', out[0]['name'])

    def test_search_url_builders(self):
        global_url = dex.build_global_search_url('TRUMP')
        self.assertIn('/search?', global_url)
        self.assertIn('query=TRUMP', global_url)
        pool_url = dex.build_pool_search_url(
            'ethereum', {'token_address': '0xabc', 'limit': 25}
        )
        self.assertIn('/networks/ethereum/pools/search?', pool_url)
        self.assertIn('token_address=0xabc', pool_url)

    def test_format_usd(self):
        self.assertEqual(dex.format_usd(150000000), '$150.0M')
        self.assertEqual(dex.format_usd(3400), '$3.4K')
        self.assertEqual(dex.format_usd(12), '$12')

    def test_empty_search_query(self):
        self.assertEqual(dex.search('ethereum', '   '), [])


class QuoteParseTest(unittest.TestCase):
    def test_dexpaprika_token(self):
        q = dex.parse_dexpaprika_token({'summary': {'price_usd': 13.14}})
        self.assertEqual(q, {'price': 13.14})
        q = dex.parse_dexpaprika_token(
            {'price_usd': 2.5, 'price_change_percentage_24h': -1.2}
        )
        self.assertEqual(q['price'], 2.5)
        self.assertAlmostEqual(q['change24h'], -1.2)

    def test_dexpaprika_token_no_price(self):
        with self.assertRaises(ValueError):
            dex.parse_dexpaprika_token({'summary': {}})

    def test_gecko_token(self):
        q = dex.parse_gecko_token(
            {
                'data': {
                    'attributes': {
                        'price_usd': '13.14',
                        'price_change_percentage': {'h24': '1.5'},
                    }
                }
            }
        )
        self.assertAlmostEqual(q['price'], 13.14)
        self.assertAlmostEqual(q['change24h'], 1.5)

    def test_batch_prices(self):
        out = dex.parse_batch_prices(
            {'prices': {'0xabc': {'price_usd': 1.5}}}
        )
        self.assertAlmostEqual(out['0xabc']['price'], 1.5)


class ValidationPathsTest(unittest.TestCase):
    ADDR = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'

    def test_candles_rejects_bad_interval_offline(self):
        with self.assertRaises(ValueError):
            dex.candles('ethereum', 'ethereum:' + self.ADDR, '10m', limit=10)

    def test_candles_rejects_venue_mismatch_offline(self):
        with self.assertRaises(ValueError):
            dex.candles('solana', 'ethereum:' + self.ADDR, '1h', limit=10)

    def test_candles_rejects_bad_symbol_offline(self):
        with self.assertRaises(ValueError):
            dex.candles('ethereum', 'not-a-pool', '1h', limit=10)

    def test_last_fetch_info_default(self):
        info = dex.get_last_fetch_info()
        self.assertIn('providers', info)
        self.assertEqual(info['providers'], [])


if __name__ == '__main__':
    unittest.main()

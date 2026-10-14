"""Offline fixture tests for the macro source (stdlib unittest, no network)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'sources'))

import macro


SDMX_FIXTURE = {
    'dataSets': [{'series': {
        '0:0:0:0:0': {'observations': {
            '0': [1.08, 0, 0, 0], '1': [1.09, 0, 0, 0], '2': [None, 0, 0, 0]}},
        '1:0:0:0:0': {'observations': {
            '0': ['160.5', 0], '1': ['-', 0]}},
    }}],
    'structure': {'dimensions': {'series': [], 'observation': [
        {'id': 'TIME_PERIOD', 'values': [
            {'id': '2024-01-02'}, {'id': '2024-01-03'}, {'id': '2024-01-04'}]},
    ]}},
}

SDMX_ALT_SHAPE = {  # lowercase keys + 'obs' + plain-string periods
    'datasets': [{'series': {
        '0': {'obs': {'0': [2.5], '1': 'N/A'}},
    }}],
    'structure': {'dimensions': {'observation': [
        {'id': 'TIME_PERIOD', 'values': ['2024-02-01', '2024-02-02']},
    ]}},
}

FUNDING_FIXTURE = [
    {'symbol': 'BTCUSDT', 'fundingRate': '0.0002', 'fundingTime': 1704249600000},
    {'symbol': 'BTCUSDT', 'fundingRate': '0.0001', 'fundingTime': 1704220800000},
    {'symbol': 'BTCUSDT', 'fundingTime': 1704278400000},  # no rate -> skipped
    {'symbol': 'BTCUSDT', 'fundingRate': 'bad', 'fundingTime': 1704278400000},
]

OI_FIXTURE = [
    {'symbol': 'BTCUSDT', 'sumOpenInterest': '100.0',
     'sumOpenInterestValue': '4200000.5', 'timestamp': 1704220800000},
    {'symbol': 'BTCUSDT', 'sumOpenInterest': '101.0', 'timestamp': 1704224400000},
    {'symbol': 'BTCUSDT', 'timestamp': 1704228000000},  # no OI -> skipped
]

STOOQ_FIXTURE = (
    'Date,Open,High,Low,Close,Volume\n'
    '2024-01-03,100.50,102.00,100.00,101.50,2000\n'
    '2024-01-02,100.00,101.00,99.00,100.50,1000\n'
    '2024-01-04,N/A,N/A,N/A,N/A,N/A\n'
)


class TestContract(unittest.TestCase):
    def test_ids(self):
        self.assertEqual(macro.SOURCE, 'macro')
        self.assertEqual(macro.LABEL, 'Rates & Derivatives')
        self.assertEqual(macro.INTERVALS, ['1h', '1d', '1wk'])

    def test_venues(self):
        ids = [v['id'] for v in macro.venues()]
        self.assertEqual(ids, ['ECB-FX', 'ECB-YC', 'Binance-Derivs', 'Stooq'])


class TestSdmx(unittest.TestCase):
    def test_parse_multi_series(self):
        out = macro.parse_sdmx_json(SDMX_FIXTURE)
        self.assertEqual(out['0:0:0:0:0'],
                         [('2024-01-02', 1.08), ('2024-01-03', 1.09)])
        self.assertEqual(out['1:0:0:0:0'], [('2024-01-02', 160.5)])

    def test_parse_generic_shape(self):
        out = macro.parse_sdmx_json(SDMX_ALT_SHAPE)
        self.assertEqual(out['0'], [('2024-02-01', 2.5)])

    def test_parse_rejects_garbage(self):
        with self.assertRaises(ValueError):
            macro.parse_sdmx_json({'nope': True})
        with self.assertRaises(ValueError):
            macro.parse_sdmx_json([])

    def test_series_to_candles(self):
        points = [('2024-01-03', 1.09), ('2024-01-02', 1.08), ('bogus', 5.0)]
        candles = macro.sdmx_series_to_candles(points)
        self.assertEqual(len(candles), 2)  # bad period skipped
        self.assertLess(candles[0]['t'], candles[1]['t'])  # ascending
        for c in candles:
            self.assertEqual((c['o'], c['h'], c['l']), (c['c'], c['c'], c['c']))
            self.assertEqual(c['v'], 0)

    def test_series_to_candles_limit(self):
        pts = [('2024-01-%02d' % d, float(d)) for d in range(1, 10)]
        self.assertEqual(len(macro.sdmx_series_to_candles(pts, limit=3)), 3)

    def test_monthly_period(self):
        candles = macro.sdmx_series_to_candles([('2024-01', 3.1)])
        self.assertEqual(len(candles), 1)

    def test_url_builders(self):
        self.assertEqual(
            macro.ecb_fx_url('USD'),
            'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=jsondata')
        self.assertIn('SR_10Y', macro.ecb_yc_url('10Y'))
        self.assertIn('SV_C_YM', macro.ecb_yc_url('10Y'))
        self.assertIn('/IRS/', macro.ecb_irs_url('DE'))
        self.assertIn('symbol=BTCUSDT', macro.binance_funding_url('BTCUSDT', 100))
        self.assertIn('openInterestHist', macro.binance_oi_hist_url('BTCUSDT', '1h', 10))
        self.assertIn('openInterest', macro.binance_oi_snapshot_url('BTCUSDT'))
        u = macro.stooq_url('aapl.us', '20240101', '20240201', 'd')
        self.assertIn('stooq.com/q/d/l/', u)


class TestFunding(unittest.TestCase):
    def test_parse_funding_rows(self):
        out = macro.parse_funding_rows(FUNDING_FIXTURE)
        self.assertEqual(len(out), 2)  # two bad rows skipped
        self.assertLess(out[0]['t'], out[1]['t'])  # ascending despite input order
        self.assertEqual(out[0]['c'], 0.0001)
        self.assertEqual(out[1]['c'], 0.0002)
        self.assertEqual(out[0]['v'], 0)

    def test_parse_oi_prefers_value(self):
        out = macro.parse_oi_rows(OI_FIXTURE)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]['c'], 4200000.5)  # sumOpenInterestValue wins
        self.assertEqual(out[1]['c'], 101.0)      # falls back to sumOpenInterest
        self.assertLess(out[0]['t'], out[1]['t'])

    def test_parse_oi_snapshot(self):
        c = macro.parse_oi_snapshot({'symbol': 'BTCUSDT', 'openInterest': '123.5',
                                     'time': 1704220800000})
        self.assertEqual((c['o'], c['c'], c['t']), (123.5, 123.5, 1704220800000))
        with self.assertRaises(ValueError):
            macro.parse_oi_snapshot({'symbol': 'BTCUSDT'})


class TestStooq(unittest.TestCase):
    def test_parse_csv(self):
        out = macro.parse_stooq_csv(STOOQ_FIXTURE)
        self.assertEqual(len(out), 2)  # N/A row skipped
        self.assertLess(out[0]['t'], out[1]['t'])  # sorted ascending
        self.assertEqual((out[0]['o'], out[0]['h'], out[0]['l'],
                          out[0]['c'], out[0]['v']),
                         (100.0, 101.0, 99.0, 100.5, 1000))

    def test_parse_csv_limit(self):
        out = macro.parse_stooq_csv(STOOQ_FIXTURE, limit=1)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['c'], 101.5)  # keeps the latest

    def test_parse_csv_rejects_garbage(self):
        with self.assertRaises(ValueError):
            macro.parse_stooq_csv('')
        with self.assertRaises(ValueError):
            macro.parse_stooq_csv('foo,bar\n1,2\n')
        with self.assertRaises(ValueError):
            macro.parse_stooq_csv('Date,Open,High,Low,Close,Volume\n')


class TestWeekly(unittest.TestCase):
    def test_resample_weekly(self):
        # 2024-01-01 (Mon) .. 2024-01-09 (Tue): two ISO weeks.
        daily = []
        base = macro._period_to_ms('2024-01-01')
        for i, px in enumerate([10, 12, 11, 13, 14, 15, 16, 17, 18]):
            daily.append({'t': base + i * 86400000, 'o': px, 'h': px + 1,
                          'l': px - 1, 'c': px, 'v': 0})
        out = macro.resample_weekly(daily)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]['o'], 10)
        self.assertEqual(out[0]['c'], 16)
        self.assertEqual(out[0]['h'], 17)
        self.assertEqual(out[0]['l'], 9)
        self.assertEqual(out[1]['o'], 17)


class TestIntervals(unittest.TestCase):
    def test_source_level_rejection(self):
        with self.assertRaises(Exception) as cm:
            macro.candles('ECB-FX', 'USD/EUR', '1m')
        self.assertIn("['1h', '1d', '1wk']", str(cm.exception))

    def test_venue_level_rejection_ecb_intraday(self):
        with self.assertRaises(Exception) as cm:
            macro.candles('ECB-FX', 'USD/EUR', '1h')
        self.assertIn("['1d', '1wk']", str(cm.exception))

    def test_venue_level_rejection_binance_weekly(self):
        with self.assertRaises(Exception) as cm:
            macro.candles('Binance-Derivs', 'BTCUSDT', '1wk')
        self.assertIn("['1h', '1d']", str(cm.exception))

    def test_venue_level_rejection_stooq_intraday(self):
        with self.assertRaises(Exception) as cm:
            macro.candles('Stooq', 'aapl.us', '1h')
        self.assertIn("['1d', '1wk']", str(cm.exception))

    def test_unknown_venue(self):
        with self.assertRaises(Exception):
            macro.candles('Nope', 'X', '1d')
        with self.assertRaises(Exception):
            macro.search('Nope', 'x')

    def test_bad_symbols_rejected_offline(self):
        with self.assertRaises(Exception):
            macro.candles('ECB-FX', 'hotdog', '1d')
        with self.assertRaises(Exception):
            macro.candles('ECB-YC', 'hotdog', '1d')
        with self.assertRaises(Exception):
            macro.candles('Binance-Derivs', '!!!', '1d')


class TestSearch(unittest.TestCase):
    def test_fx_registry_hit(self):
        hits = macro.search('ECB-FX', 'usd')
        self.assertTrue(any(h['symbol'] == 'USD/EUR' for h in hits))

    def test_fx_passthrough(self):
        hits = macro.search('ECB-FX', 'XYZ')
        self.assertIn({'symbol': 'XYZ/EUR', 'name': 'XYZ / Euro (ECB reference)'}, hits)

    def test_yc_registry_and_tenors(self):
        hits = macro.search('ECB-YC', 'EUR10Y')
        self.assertTrue(any(h['symbol'] == 'EUR10Y' for h in hits))
        hits = macro.search('ECB-YC', 'irs')
        self.assertTrue(any(h['symbol'] == 'DE10Y-IRS' for h in hits))

    def test_binance_passthrough(self):
        hits = macro.search('Binance-Derivs', 'doge')
        self.assertTrue(any(h['symbol'] == 'DOGEUSDT' for h in hits))
        hits = macro.search('Binance-Derivs', 'SOLUSDT:OI')
        self.assertTrue(any(h['symbol'] == 'SOLUSDT:OI' for h in hits))

    def test_stooq_empty_query_returns_top(self):
        hits = macro.search('Stooq', '')
        self.assertTrue(len(hits) > 0)
        self.assertTrue(all('symbol' in h and 'name' in h for h in hits))


if __name__ == '__main__':
    unittest.main()

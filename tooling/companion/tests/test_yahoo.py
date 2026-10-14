"""Offline unit tests for tooling/companion/sources/yahoo.py (workstream C).

Fully offline: every test uses inline fixtures or injected fake fetchers, no
network. Live spot-checks are documented as notes only (see LIVE NOTES at the
bottom) and never gate tests.
"""
import importlib.util
import os
import unittest
from unittest import mock
from urllib.error import HTTPError

_HERE = os.path.dirname(os.path.abspath(__file__))
_YAHOO_PATH = os.path.normpath(os.path.join(_HERE, '..', 'sources', 'yahoo.py'))


def _load():
    spec = importlib.util.spec_from_file_location('yahoo_source', _YAHOO_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


yahoo = _load()

# --- fixtures ---------------------------------------------------------------

_TS = [1700000000, 1700086400, 1700172800, 1700259200]


def _chart_payload(ts=_TS, opens=None, highs=None, lows=None,
                   closes=None, vols=None, adj=None):
    opens = [200.0, 204.0, None, 104.0] if opens is None else opens
    highs = [202.0, 206.0, None, 106.0] if highs is None else highs
    lows = [198.0, 202.0, None, 102.0] if lows is None else lows
    closes = [201.0, 205.0, None, 105.0] if closes is None else closes
    vols = [1000, 1100, None, 1200] if vols is None else vols
    adj = [100.5, 102.5, None, 105.0] if adj is None else adj
    return {
        'chart': {
            'result': [{
                'timestamp': list(ts),
                'indicators': {
                    'quote': [{
                        'open': list(opens), 'high': list(highs),
                        'low': list(lows), 'close': list(closes),
                        'volume': list(vols),
                    }],
                    'adjclose': [{'adjclose': list(adj)}],
                },
            }],
            'error': None,
        }
    }


EMPTY_CHART = {
    'chart': {
        'result': [{
            'timestamp': [],
            'indicators': {
                'quote': [{'open': [], 'high': [], 'low': [],
                           'close': [], 'volume': []}],
                'adjclose': [{'adjclose': []}],
            },
        }],
        'error': None,
    }
}

ERROR_CHART = {
    'chart': {'result': None,
              'error': {'code': 'Not Found', 'description': 'No data found'}},
}

SEARCH_FIXTURE = {
    'quotes': [
        {'symbol': 'AAPL', 'shortname': 'Apple Inc.', 'longname': 'Apple Inc.'},
        {'symbol': 'AAPLW', 'longname': 'Apple Warrant'},
        {'symbol': 'AAPLE', 'shortname': 'AAPLE Fund'},
        {'symbol': 'AAPL34.SA'},
        {'symbol': 'AAPL.MX', 'shortname': 'Apple Mexico'},
        {'symbol': 'APC.DE', 'shortname': 'Apple Deutschland'},
        {'symbol': 'APC.F', 'longname': 'Apple Frankfurt'},
        {'symbol': 'AAPL.SW', 'shortname': 'Apple Swiss'},
        {'symbol': 'EXTRA1', 'shortname': 'Beyond top eight'},
        {'symbol': 'EXTRA2', 'shortname': 'Also beyond'},
    ]
}


def _recording_fetcher(payloads):
    """Fake fetcher returning queued payloads (or raising queued errors)."""
    calls = []

    def fetch(url):
        calls.append(url)
        item = payloads[min(len(calls) - 1, len(payloads) - 1)]
        if isinstance(item, Exception):
            raise item
        return item

    fetch.calls = calls
    return fetch


# --- contract ----------------------------------------------------------------


class ContractTest(unittest.TestCase):
    def test_source_constants(self):
        self.assertEqual(yahoo.SOURCE, 'yahoo')
        self.assertEqual(yahoo.LABEL, 'Stocks & Indices')
        self.assertEqual(
            yahoo.INTERVALS,
            ['1m', '2m', '5m', '15m', '30m', '1h',
             '1d', '5d', '1wk', '1mo', '3mo'],
        )
        self.assertEqual(
            yahoo.STREAM,
            {'mode': 'poll', 'cadence': 60,
             'note': 'intraday \u226460d; daily decades'},
        )

    def test_venues(self):
        venues = yahoo.venues()
        self.assertEqual(
            [v['id'] for v in venues],
            ['US', 'NSE', 'BSE', 'LSE', 'TSE', 'TSX', 'ASX', 'B3',
             'HKEX', 'Euronext', 'FX', 'Commodities', 'Rates', 'Indices'],
        )
        for v in venues:
            self.assertTrue(v['id'])
            self.assertTrue(v['label'])


# --- ticker construction ------------------------------------------------------


class TickerTest(unittest.TestCase):
    def test_suffix_map(self):
        cases = [
            ('US', 'AAPL', 'AAPL'),
            ('US', 'BRK-B', 'BRK-B'),
            ('NSE', 'RELIANCE', 'RELIANCE.NS'),
            ('NSE', 'RELIANCE.NS', 'RELIANCE.NS'),
            ('BSE', '500325', '500325.BO'),
            ('LSE', 'VOD', 'VOD.L'),
            ('TSE', '7203', '7203.T'),
            ('TSX', 'SHOP', 'SHOP.TO'),
            ('ASX', 'CBA', 'CBA.AX'),
            ('B3', 'PETR4', 'PETR4.SA'),
            ('HKEX', '700', '0700.HK'),
            ('HKEX', '0700.HK', '0700.HK'),
            ('Euronext', 'ACA', 'ACA.PA'),
            ('Euronext', 'PA:AI', 'AI.PA'),
            ('Euronext', 'XAMS:ADYEN', 'ADYEN.AS'),
            ('Euronext', 'ACA.PA', 'ACA.PA'),
            ('FX', 'EURUSD', 'EURUSD=X'),
            ('FX', 'EURUSD=X', 'EURUSD=X'),
            ('FX', 'EUR/USD', 'EURUSD=X'),
            ('Commodities', 'GC=F', 'GC=F'),
            ('Commodities', 'gc=f', 'GC=F'),
            ('Rates', '^TNX', '^TNX'),
            ('Indices', '^GSPC', '^GSPC'),
        ]
        for venue, symbol, expected in cases:
            with self.subTest(venue=venue, symbol=symbol):
                self.assertEqual(yahoo.build_ticker(venue, symbol), expected)

    def test_sau_mc_passthrough(self):
        # No dedicated Tadawul/Madrid venues in the 14-venue contract; already
        # suffixed tickers pass through verbatim (e.g. via US), so no data loss.
        self.assertEqual(yahoo.build_ticker('US', '2222.SAU'), '2222.SAU')
        self.assertEqual(yahoo.build_ticker('US', 'BBVA.MC'), 'BBVA.MC')

    def test_rejects(self):
        with self.assertRaises(Exception):
            yahoo.build_ticker('NOPE', 'AAPL')
        with self.assertRaises(Exception):
            yahoo.build_ticker('US', '')
        with self.assertRaises(Exception):
            yahoo.build_ticker('US', 'AA PL')  # space not in symbol charset
        with self.assertRaises(Exception):
            yahoo.build_ticker('Euronext', 'XX:FOO')


# --- range sizing --------------------------------------------------------------


class RangeTest(unittest.TestCase):
    def test_pick_range(self):
        self.assertEqual(yahoo.pick_range('1d', 300), '1y')
        self.assertEqual(yahoo.pick_range('1m', 300), '1d')
        self.assertEqual(yahoo.pick_range('1h', 300), '1mo')
        self.assertEqual(yahoo.pick_range('1wk', 300), '10y')
        self.assertEqual(yahoo.pick_range('3mo', 300), 'max')
        self.assertEqual(yahoo.pick_range('1m', 1000), '1d')

    def test_intraday_capped(self):
        self.assertEqual(yahoo.pick_range('1m', 200000), '3mo')

    def test_bad_interval(self):
        with self.assertRaises(Exception):
            yahoo.pick_range('10m', 100)


# --- chart parsing --------------------------------------------------------------


class ParseTest(unittest.TestCase):
    def test_adjclose_math(self):
        # 2:1 split after bar 2: pre-split closes halve via adjclose ratio.
        bars = yahoo.parse_chart(_chart_payload())
        self.assertEqual(len(bars), 3)  # all-None row skipped
        self.assertAlmostEqual(bars[0]['o'], 100.0)
        self.assertAlmostEqual(bars[0]['h'], 101.0)
        self.assertAlmostEqual(bars[0]['l'], 99.0)
        self.assertAlmostEqual(bars[0]['c'], 100.5)
        self.assertAlmostEqual(bars[1]['c'], 102.5)
        self.assertAlmostEqual(bars[2]['o'], 104.0)
        self.assertAlmostEqual(bars[2]['c'], 105.0)

    def test_volume_none_becomes_zero(self):
        payload = _chart_payload(
            ts=[1700000000], opens=[10.0], highs=[11.0], lows=[9.0],
            closes=[10.5], vols=[None], adj=[10.5])
        bars = yahoo.parse_chart(payload)
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0]['v'], 0)

    def test_empty_payload_parses_to_no_bars(self):
        self.assertEqual(yahoo.parse_chart(EMPTY_CHART), [])

    def test_error_payload_raises(self):
        with self.assertRaises(Exception):
            yahoo.parse_chart(ERROR_CHART)


# --- candles --------------------------------------------------------------------


class CandlesTest(unittest.TestCase):
    def test_record_shape_and_ascending(self):
        fetch = _recording_fetcher([_chart_payload()])
        bars = yahoo.candles('US', 'AAPL', '1d', limit=10, _fetcher=fetch)
        self.assertEqual(len(bars), 3)
        for b in bars:
            self.assertEqual(set(b.keys()), {'t', 'o', 'h', 'l', 'c', 'v'})
            self.assertIsInstance(b['t'], int)
        ts = [b['t'] for b in bars]
        self.assertEqual(ts, sorted(ts))
        self.assertEqual(ts[0], 1700000000 * 1000)
        for b in bars:
            for k in ('o', 'h', 'l', 'c', 'v'):
                self.assertIsInstance(b[k], float)
            self.assertGreaterEqual(b['v'], 0)

    def test_limit_trims_to_latest(self):
        payload = _chart_payload(
            ts=[1700000000, 1700086400, 1700172800, 1700259200, 1700345600],
            opens=[1.0, 2.0, 3.0, 4.0, 5.0],
            highs=[1.0, 2.0, 3.0, 4.0, 5.0],
            lows=[1.0, 2.0, 3.0, 4.0, 5.0],
            closes=[1.0, 2.0, 3.0, 4.0, 5.0],
            vols=[10, 20, 30, 40, 50],
            adj=[1.0, 2.0, 3.0, 4.0, 5.0])
        fetch = _recording_fetcher([payload])
        bars = yahoo.candles('US', 'AAPL', '1d', limit=2, _fetcher=fetch)
        self.assertEqual([b['c'] for b in bars], [4.0, 5.0])

    def test_interval_validation(self):
        fetch = _recording_fetcher([_chart_payload()])
        with self.assertRaises(Exception) as ctx:
            yahoo.candles('US', 'AAPL', '10m', _fetcher=fetch)
        self.assertIn('unsupported interval', str(ctx.exception))
        self.assertEqual(len(fetch.calls), 0)  # rejected before any fetch

    def test_empty_raises_never_substitutes(self):
        fetch = _recording_fetcher([EMPTY_CHART])
        with self.assertRaises(Exception) as ctx:
            yahoo.candles('US', 'AAPL', '1d', _fetcher=fetch)
        self.assertIn('empty', str(ctx.exception).lower())
        # query1 tried, then query2 fallback host tried.
        self.assertEqual(len(fetch.calls), 2)
        self.assertIn('query1', fetch.calls[0])
        self.assertIn('query2', fetch.calls[1])

    def test_nse_bo_fallback(self):
        fetch = _recording_fetcher([EMPTY_CHART, EMPTY_CHART,
                                    _chart_payload()])
        bars = yahoo.candles('NSE', 'RELIANCE', '1d', _fetcher=fetch)
        self.assertEqual(len(bars), 3)
        self.assertTrue(any('RELIANCE.BO' in u for u in fetch.calls))

    def test_rate_limited_message(self):
        err = Exception('rate limited (429), retry shortly')
        fetch = _recording_fetcher([err, err])
        with self.assertRaises(Exception) as ctx:
            yahoo.candles('US', 'AAPL', '1d', _fetcher=fetch)
        self.assertEqual(str(ctx.exception),
                         'rate limited (429), retry shortly')


# --- search ----------------------------------------------------------------------


class SearchTest(unittest.TestCase):
    def test_top_eight_with_names(self):
        fetch = _recording_fetcher([SEARCH_FIXTURE])
        rows = yahoo.search('US', 'apple', _fetcher=fetch)
        self.assertEqual(len(rows), 8)
        self.assertEqual(rows[0], {'symbol': 'AAPL', 'name': 'Apple Inc.'})
        self.assertEqual(rows[1]['name'], 'Apple Warrant')  # longname fallback
        self.assertEqual(rows[3]['name'], 'AAPL34.SA')  # symbol fallback
        for r in rows:
            self.assertEqual(set(r.keys()), {'symbol', 'name'})
        self.assertIn('v1/finance/search', fetch.calls[0])

    def test_empty_query_raises(self):
        fetch = _recording_fetcher([SEARCH_FIXTURE])
        with self.assertRaises(Exception):
            yahoo.search('US', '   ', _fetcher=fetch)
        self.assertEqual(len(fetch.calls), 0)


# --- quote ------------------------------------------------------------------------


class QuoteTest(unittest.TestCase):
    def test_change_math(self):
        payload = _chart_payload(
            ts=[1700000000, 1700086400, 1700172800],
            opens=[100.0, 102.0, 105.0], highs=[100.0, 102.0, 105.0],
            lows=[100.0, 102.0, 105.0], closes=[100.0, 102.0, 105.0],
            vols=[10, 20, 30], adj=[100.0, 102.0, 105.0])
        fetch = _recording_fetcher([payload])
        q = yahoo.quote('US', 'AAPL', _fetcher=fetch)
        self.assertEqual(q['price'], 105.0)
        self.assertEqual(q['prev_close'], 102.0)
        self.assertAlmostEqual(q['change_pct'], (105.0 - 102.0) / 102.0 * 100)
        self.assertEqual(q['t'], 1700172800 * 1000)

    def test_needs_two_bars(self):
        payload = _chart_payload(
            ts=[1700000000], opens=[1.0], highs=[1.0], lows=[1.0],
            closes=[1.0], vols=[5], adj=[1.0])
        fetch = _recording_fetcher([payload])
        with self.assertRaises(Exception):
            yahoo.quote('US', 'AAPL', _fetcher=fetch)


# --- transport ---------------------------------------------------------------------


class TransportTest(unittest.TestCase):
    def test_user_agents_rotate(self):
        self.assertGreaterEqual(len(yahoo._UAS), 2)
        self.assertEqual(len(set(yahoo._UAS)), len(yahoo._UAS))
        self.assertNotEqual(yahoo._pick_ua(0), yahoo._pick_ua(1))
        self.assertEqual(yahoo._pick_ua(0),
                         yahoo._pick_ua(len(yahoo._UAS)))

    def test_http_429_maps_to_rate_limited(self):
        boom = HTTPError('http://x', 429, 'Too Many Requests', {}, None)
        with mock.patch('urllib.request.urlopen', side_effect=boom):
            with self.assertRaises(Exception) as ctx:
                yahoo._get_json('http://query1.finance.yahoo.com/x')
        self.assertEqual(str(ctx.exception),
                         'rate limited (429), retry shortly')


if __name__ == '__main__':
    unittest.main()

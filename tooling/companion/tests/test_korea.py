"""Offline unit tests for tooling/companion/sources/korea.py.

Fully offline: pure parsers use inline fixtures (Naver pseudo-JSON with
single quotes + Korean headers, Naver polling bodies, Yahoo v8 payloads)
and the live legs are exercised through the ``_get`` seam (callable
url -> raw body), never the network. Live probes are informational only
(see LIVE NOTES at the bottom) and never gate tests.
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_KOREA_PATH = os.path.normpath(os.path.join(_HERE, '..', 'sources', 'korea.py'))


def _load(name='korea_source'):
    spec = importlib.util.spec_from_file_location(name, _KOREA_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


korea = _load()

# Naver siseJson fixture: single quotes, Korean header, comma-grouped
# numbers, rows deliberately out of order (ascending-sort check).
NAVER_BODY = (
    "[['\ub0a0\uc9dc','\uc2dc\uac00','\uace0\uac00','\uc800\uac00','\uc885\uac00','\uac70\ub798\ub7c9'],"
    "['20251014','79,000','79,500','78,200','79,200','1,234,567'],"
    "['20251013','78,000','78,900','77,500','78,500','2,345,678'],"
    "['20251015','79,200','80,100','79,000','79,800','987,654']]"
)

NAVER_HEADER_ONLY = "[['\ub0a0\uc9dc','\uc2dc\uac00','\uace0\uac00','\uc800\uac00','\uc885\uac00','\uac70\ub798\ub7c9']]"

POLLING_LONG = {
    'result': {'areas': [{'name': 'SERVICE_ITEM', 'datas': [
        {'cd': '005930', 'closePrice': 79200, 'openPrice': 79000,
         'highPrice': 79500, 'lowPrice': 78200,
         'accumulatedTradingVolume': 1234567,
         'marketStatus': 'OPEN', 'localTradedAt': 1728900000000}]}]}}

POLLING_SHORT = {
    'result': {'areas': [{'name': 'SERVICE_ITEM', 'datas': [
        {'cd': '000660', 'nv': 150000, 'ov': 149000, 'hv': 151000,
         'lv': 148000, 'aq': 765432, 'ms': 'CLOSE'}]}]}}

POLLING_BATCH = {
    'result': {'areas': [{'name': 'SERVICE_ITEM', 'datas': [
        {'cd': '005930', 'nv': 79200, 'ov': 79000, 'hv': 79500,
         'lv': 78200, 'aq': 100},
        {'cd': '000660', 'nv': 150000, 'ov': 149000, 'hv': 151000,
         'lv': 148000, 'aq': 200}]}]}}


def _yahoo_payload(base_ts=1728806400, closes=(78000.0, 78500.0, 79200.0)):
    n = len(closes)
    stamps = [base_ts + i * 86400 for i in range(n)]
    return {'chart': {'result': [{
        'timestamp': stamps,
        'indicators': {
            'quote': [{'open': [c - 500.0 for c in closes],
                       'high': [c + 300.0 for c in closes],
                       'low': [c - 800.0 for c in closes],
                       'close': list(closes),
                       'volume': [1000.0 * (i + 1) for i in range(n)]}],
            'adjclose': [{'adjclose': list(closes)}]}}],
        'error': None}}


def _yahoo_body(**kw):
    import json
    return json.dumps(_yahoo_payload(**kw))


class ContractTest(unittest.TestCase):
    def test_contract_constants(self):
        self.assertEqual(korea.SOURCE, 'korea')
        self.assertTrue(str(korea.LABEL))
        self.assertEqual(list(korea.INTERVALS), ['1d', '1wk', '1mo'])
        for key in ('mode', 'cadence', 'note'):
            self.assertIn(key, korea.STREAM)
        self.assertEqual(korea.STREAM['mode'], 'poll')

    def test_venues(self):
        ids = [v['id'] for v in korea.venues()]
        self.assertIn('KOSPI', ids)
        self.assertIn('KOSDAQ', ids)

    def test_stdlib_only(self):
        import ast
        with open(_KOREA_PATH, encoding='utf-8') as fh:
            tree = ast.parse(fh.read())
        allowed = {'json', 're', 'time', 'urllib', 'datetime'}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertIn(alias.name.split('.')[0], allowed)
            elif isinstance(node, ast.ImportFrom):
                self.assertIn((node.module or '').split('.')[0], allowed)


class SymbolVenueTest(unittest.TestCase):
    def test_bare_code(self):
        self.assertEqual(korea.normalize_code('005930'), '005930')

    def test_suffixes_and_prefixes_accepted(self):
        self.assertEqual(korea.normalize_code('005930.KS'), '005930')
        self.assertEqual(korea.normalize_code('000660.kq'), '000660')
        self.assertEqual(korea.normalize_code('KRX:005930'), '005930')

    def test_no_code_raises(self):
        with self.assertRaises(Exception):
            korea.normalize_code('SAMSUNG')

    def test_empty_raises(self):
        with self.assertRaises(Exception):
            korea.normalize_code('  ')

    def test_venue_loose_never_rejects_valid_code(self):
        # Any valid 6-digit code is routable under either venue.
        get = lambda url: NAVER_BODY  # noqa: E731
        for venue in ('KOSPI', 'KOSDAQ', '', None):
            bars = korea.candles(venue, '005930', '1d', 5, _get=get)
            self.assertTrue(bars)

    def test_unknown_venue_raises(self):
        with self.assertRaises(Exception):
            korea.candles('NYSE', '005930', '1d', 5, _get=lambda u: NAVER_BODY)


class IntervalTest(unittest.TestCase):
    def test_rejected_names_supported_list(self):
        for bad in ('5m', '1h', '1m-bad', '1D', 'daily', ''):
            with self.assertRaisesRegex(Exception, 'supported'):
                korea.candles('KOSPI', '005930', bad, 5,
                              _get=lambda u: NAVER_BODY)

    def test_primary_intervals_route(self):
        get = lambda url: NAVER_BODY  # noqa: E731
        for interval in ('1d', '1wk', '1mo'):
            bars = korea.candles('KOSPI', '005930', interval, 5, _get=get)
            self.assertTrue(bars)


class NaverParseTest(unittest.TestCase):
    def test_single_quote_korean_header_tolerance(self):
        bars = korea.parse_sise_json(NAVER_BODY)
        self.assertEqual(len(bars), 3)
        first = bars[0]
        self.assertEqual(
            first['t'], korea._date_to_ms('20251013'))
        self.assertEqual(
            (first['o'], first['h'], first['l'], first['c'], first['v']),
            (78000.0, 78900.0, 77500.0, 78500.0, 2345678.0))

    def test_ascending_records(self):
        bars = korea.parse_sise_json(NAVER_BODY)
        stamps = [b['t'] for b in bars]
        self.assertEqual(stamps, sorted(stamps))

    def test_non_array_raises(self):
        with self.assertRaises(Exception):
            korea.parse_sise_json('not json at all {{{')

    def test_header_only_parses_empty(self):
        self.assertEqual(korea.parse_sise_json(NAVER_HEADER_ONLY), [])

    def test_double_quote_variant(self):
        body = NAVER_BODY.replace("'", '"')
        bars = korea.parse_sise_json(body)
        self.assertEqual(len(bars), 3)


class PollingParseTest(unittest.TestCase):
    def test_long_keys(self):
        tick = korea.parse_polling(POLLING_LONG, '005930')
        self.assertEqual(tick['price'], 79200.0)
        self.assertEqual(tick['open'], 79000.0)
        self.assertEqual(tick['high'], 79500.0)
        self.assertEqual(tick['low'], 78200.0)
        self.assertEqual(tick['volume'], 1234567.0)
        self.assertEqual(tick['market_status'], 'OPEN')

    def test_short_keys(self):
        tick = korea.parse_polling(POLLING_SHORT, '000660')
        self.assertEqual(
            (tick['price'], tick['open'], tick['high'], tick['low']),
            (150000.0, 149000.0, 151000.0, 148000.0))

    def test_batch_picks_requested_code(self):
        tick = korea.parse_polling(POLLING_BATCH, '000660')
        self.assertEqual(tick['price'], 150000.0)

    def test_absent_code_raises(self):
        with self.assertRaises(Exception):
            korea.parse_polling(POLLING_LONG, '000660')


class FallbackTest(unittest.TestCase):
    def test_naver_primary_trail(self):
        bars = korea.candles('KOSPI', '005930', '1d', 5,
                             _get=lambda u: NAVER_BODY)
        self.assertEqual(len(bars), 3)
        self.assertEqual(korea.last_fallback(), ['naver'])

    def test_yahoo_fallback_selection(self):
        import json

        def get(url):
            if 'siseJson' in url:
                raise Exception('Naver hiccup (fixture)')
            return json.dumps(_yahoo_payload())

        bars = korea.candles('KOSPI', '005930', '1d', 5, _get=get)
        self.assertEqual(len(bars), 3)
        trail = korea.last_fallback()
        self.assertTrue(any(t.startswith('yahoo:') for t in trail),
                        trail)
        self.assertIn('005930.KS', trail[-1])

    def test_kosdaq_prefers_kq(self):
        import json

        def get(url):
            if 'siseJson' in url:
                raise Exception('Naver hiccup (fixture)')
            return json.dumps(_yahoo_payload())

        korea.candles('KOSDAQ', '000660', '1d', 5, _get=get)
        self.assertIn('000660.KQ', korea.last_fallback()[-1])

    def test_empty_both_legs_raise(self):
        import json

        def get(url):
            if 'siseJson' in url:
                return NAVER_HEADER_ONLY
            return json.dumps({'chart': {'result': [], 'error': None}})

        with self.assertRaisesRegex(Exception, '[Nn]aver.*[Yy]ahoo'):
            korea.candles('KOSPI', '005930', '1d', 5, _get=get)


class QuoteTest(unittest.TestCase):
    def test_polling_quote(self):
        import json
        tick = korea.quote(
            'KOSPI', '005930',
            _get=lambda u: json.dumps(POLLING_LONG))
        self.assertEqual(tick['price'], 79200.0)
        self.assertEqual(tick['fallback'], [])
        self.assertEqual(tick['provider'], 'naver')

    def test_quote_yahoo_fallback(self):
        import json

        def get(url):
            if 'polling.finance.naver.com' in url:
                raise Exception('polling hiccup (fixture)')
            return json.dumps(_yahoo_payload())

        tick = korea.quote('KOSPI', '005930', _get=get)
        self.assertEqual(tick['provider'], 'yahoo')
        self.assertTrue(tick['fallback'])
        self.assertAlmostEqual(tick['price'], 79200.0)


class SearchTest(unittest.TestCase):
    def test_code_pattern_guess_list(self):
        rows = korea.search('', '005930')
        self.assertEqual([r['symbol'] for r in rows],
                         ['005930', '005930'])
        self.assertTrue(all('guess' in r['name'] for r in rows))

    def test_pinned_venue_single_guess(self):
        rows = korea.search('KOSPI', '005930')
        self.assertEqual(len(rows), 1)

    def test_name_lookup(self):
        rows = korea.search('', 'samsung electronics')
        self.assertTrue(any(r['symbol'] == '005930' for r in rows))

    def test_empty_query(self):
        self.assertEqual(korea.search('', '  '), [])


if __name__ == '__main__':
    unittest.main()


# LIVE NOTES (informational only; never gate tests):
# - Naver siseJson: GET NAVER_CHART_URL?symbol=005930&requestType=1
#   &startTime=<YYYYMMDD>&endTime=<YYYYMMDD>&timeframe=day
# - Naver polling: GET NAVER_POLL_URL + '005930' (comma-batch supported)
# - Yahoo fallback: GET https://query1.finance.yahoo.com/v8/finance/chart/
#   005930.KS?interval=1d&range=1y (delayed ~15min)
# Probes were not run as part of the offline suite; run them manually
# where network is allowed.

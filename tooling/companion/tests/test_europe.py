"""Offline unit tests for tooling/companion/sources/europe.py.

Fully offline: every test uses inline fixtures or injected fake fetchers, no
network. Live spot-checks are notes only (see LIVE NOTES at the bottom) and
never gate tests.
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_EUROPE_PATH = os.path.normpath(os.path.join(_HERE, '..', 'sources',
                                             'europe.py'))


def _load():
    spec = importlib.util.spec_from_file_location('europe_source',
                                                  _EUROPE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


europe = _load()

# --- fixtures ---------------------------------------------------------------

SIX_FIXTURE = {
    'valors': [{
        'valorId': '1200526',
        'instrument': 'CH0012005267CHF4',
        'data': {
            'Date': ['20240102', '20240103', '20240104', '20240105'],
            'Time': ['18:00', '18:00', '18:00', '18:00'],
            'Close': [100.5, 101.0, None, 102.25],
            'Open': [100.0, 100.5, None, 101.5],
            'Low': [99.5, 100.0, None, 101.0],
            'High': [101.0, 101.5, None, 102.5],
            'TotalVolume': [1200, 1300, None, None],
        },
    }],
}

SIX_EMPTY = {'valors': [{'valorId': '1200526', 'data': {
    'Date': [], 'Time': [], 'Close': [], 'Open': [],
    'Low': [], 'High': [], 'TotalVolume': []}}]}

SIX_RESOLVE_CSV = (
    'ValorSymbol;ValorId;ISIN;TradingBaseCurrency;ValorNumber\n'
    'NOVN;CH0012005267CHF4;CH0012005267;CHF;1200526\n')


BORSA_FIXTURE = {
    'history': [
        {'date': '2024-01-02', 'open': 20.0, 'high': 21.0,
         'low': 19.5, 'close': 20.5, 'volume': 5000},
        {'date': '2024-01-03', 'open': 20.5, 'high': 22.0,
         'low': 20.0, 'close': 21.5, 'volume': 6000},
        {'date': '2024-01-04', 'open': None, 'high': None,
         'low': None, 'close': None, 'volume': None},
        {'date': '2024-01-05', 'open': 21.5, 'high': 23.0,
         'low': 21.0, 'close': 22.5},
    ],
}

BORSA_EMPTY = {'history': []}

BORSA_PAGE_FIXTURE = (
    '<html><head><script>window.__CFG={"anonymous_token":'
    '"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbm9uIn0.c2lnbmF0dXJl"};'
    '</script></head><body>interactive chart</body></html>'
)
BORSA_COOKIES_FIXTURE = [
    'incap_ses_123=abc; Path=/; HttpOnly',
    'visid_incap_456=def; Path=/',
]
BORSA_WAF_PAGE = (
    '<html><head><title>Access denied</title></head><body>'
    'Request unsuccessful. Incapsula incident ID.</body></html>'
)

_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbm9uIn0.c2lnbmF0dXJl'


def _json_fetcher(payload, calls=None):
    def fetch(url, headers=None):
        (calls if calls is not None else []).append((url, headers))
        return payload
    return fetch


def _warmup_ok(url):
    return 200, list(BORSA_COOKIES_FIXTURE), BORSA_PAGE_FIXTURE


# --- contract ----------------------------------------------------------------


class ContractTest(unittest.TestCase):
    def test_source_constants(self):
        self.assertEqual(europe.SOURCE, 'europe')
        self.assertTrue(europe.LABEL)
        self.assertEqual(europe.INTERVALS, ['1d'])
        self.assertEqual(europe.STREAM['mode'], 'snapshot')
        self.assertGreater(europe.STREAM['cadence'], 0)
        self.assertTrue(europe.STREAM['note'])

    def test_venues(self):
        venues = europe.venues()
        self.assertEqual([v['id'] for v in venues],
                         ['SIX', 'NORDIC', 'BORSA-IT'])
        for v in venues:
            self.assertTrue(v['id'])
            self.assertTrue(v['label'])

    def test_bench_not_built_is_documented(self):
        with open(_EUROPE_PATH, encoding='utf-8') as fh:
            src = fh.read().lower()
        for name in ('nyx', 'boerse-frankfurt', 'onvista', 'ariva',
                     'finanzen'):
            self.assertIn(name, src)


# --- SIX ---------------------------------------------------------------------


class SixTest(unittest.TestCase):
    def test_parallel_array_parse(self):
        bars = europe.parse_six(SIX_FIXTURE)
        self.assertEqual(len(bars), 3)  # all-None row skipped
        first = bars[0]
        self.assertEqual(set(first.keys()), {'t', 'o', 'h', 'l', 'c', 'v'})
        self.assertEqual((first['o'], first['h'], first['l'],
                          first['c'], first['v']),
                         (100.0, 101.0, 99.5, 100.5, 1200.0))
        self.assertEqual(bars[-1]['v'], 0.0)  # missing volume -> 0
        self.assertEqual(bars[-1]['c'], 102.25)

    def test_daily_lands_on_utc_midnight(self):
        bars = europe.parse_six(SIX_FIXTURE)
        import datetime
        day = datetime.datetime(2024, 1, 2,
                                tzinfo=datetime.timezone.utc).timestamp()
        self.assertEqual(bars[0]['t'], int(day * 1000))

    def test_malformed_raises(self):
        for bad in ({}, {'valors': []}, {'valors': [None]},
                    {'valors': [{}]}, {'valors': [{'data': None}]},
                    {'valors': [{'data': {'Date': ['20240102']}}]},
                    'nope', None):
            with self.assertRaises(Exception, msg=repr(bad)):
                europe.parse_six(bad)

    def test_chart_url_shape(self):
        url = europe.six_chart_url('1200526', '20230101')
        self.assertIn('six-group.com/itf/fqs/delayed/charts.json', url)
        self.assertIn('netting=1440', url)
        self.assertIn('fromdate=20230101', url)
        self.assertIn('ValorId', url)
        self.assertIn('1200526', url)
        # select= is mandatory (API 400s without it) and todate bounds the window
        self.assertIn('select=ValorId', url)
        self.assertRegex(url, r'todate=\d{8}')

    def test_resolve_valorid_passthrough(self):
        # Full form passes through with no network; bare numbers resolve
        # via ref.csv (charts.json returns no rows for them directly).
        self.assertEqual(
            europe.six_resolve_valorid('CH0012221716CHF4'),
            'CH0012221716CHF4')
        csv = ('ValorSymbol;ValorId;ISIN;TradingBaseCurrency;ValorNumber\n'
               'NOVN;CH0012005267CHF4;CH0012005267;CHF;1200526\n')
        got = europe.six_resolve_valorid(
            '1200526', _fetch_text=lambda url: csv)
        self.assertEqual(got, 'CH0012005267CHF4')

    def test_resolve_valorid_via_refcsv(self):
        csv = ('ValorSymbol;ValorId;ISIN;TradingBaseCurrency;ValorNumber\n'
               'ABBN;CH0012221716CHF4;CH0012221716;CHF;1222171\n')
        got = europe.six_resolve_valorid(
            'CH0012221716', _fetch_text=lambda url: csv)
        self.assertEqual(got, 'CH0012221716CHF4')

    def test_resolve_valorid_numeric_and_symbol(self):
        csv = ('ValorSymbol;ValorId;ISIN;TradingBaseCurrency;ValorNumber\n'
               'NOVN;CH0012005267CHF4;CH0012005267;CHF;1200526\n')
        got = europe.six_resolve_valorid(
            '1200526', _fetch_text=lambda url: csv)
        self.assertEqual(got, 'CH0012005267CHF4')
        got = europe.six_resolve_valorid(
            'novn', _fetch_text=lambda url: csv)
        self.assertEqual(got, 'CH0012005267CHF4')

    def test_resolve_valorid_unknown_isin_raises(self):
        csv = ('ValorSymbol;ValorId;ISIN\n'
               'ABBN;CH0012221716CHF4;CH0012221716\n')
        with self.assertRaises(Exception) as ctx:
            europe.six_resolve_valorid(
                'CH0000000000', _fetch_text=lambda url: csv)
        self.assertIn('no ValorId mapping', str(ctx.exception))

    def test_resolve_valorid_rejects_garbage(self):
        for bad in ('', 'Nestle', 'CH-XX'):
            with self.assertRaises(Exception, msg=repr(bad)):
                europe.six_resolve_valorid(bad)

    def test_candles_ascending_and_trimmed(self):
        fetch = _json_fetcher(SIX_FIXTURE)
        bars = europe.candles('SIX', '1200526', '1d', limit=2,
                              _fetcher=fetch,
                              _resolve_text=lambda url: SIX_RESOLVE_CSV)
        self.assertEqual(len(bars), 2)
        ts = [b['t'] for b in bars]
        self.assertEqual(ts, sorted(ts))
        self.assertEqual([b['c'] for b in bars], [101.0, 102.25])

    def test_empty_raises_never_substitutes(self):
        with self.assertRaises(Exception) as ctx:
            europe.candles('SIX', '1200526', '1d',
                           _fetcher=_json_fetcher(SIX_EMPTY),
                           _resolve_text=lambda url: SIX_RESOLVE_CSV)
        self.assertIn('history unavailable', str(ctx.exception).lower())

    def test_search_direct_entry(self):
        rows = europe.search('SIX', 'CH0012005267')
        self.assertEqual(rows[0]['symbol'], 'CH0012005267')
        rows = europe.search('SIX', '1200526')
        self.assertEqual(rows[0]['symbol'], '1200526')

    def test_search_without_isin_or_valor_raises(self):
        with self.assertRaises(Exception):
            europe.search('SIX', 'Nestle')


# --- Nordic (endpoint retired; venue kept for honest errors) ------------------


class NordicRetiredTest(unittest.TestCase):
    def test_candles_raise_retired(self):
        with self.assertRaises(Exception) as ctx:
            europe.candles('NORDIC', 'SSE101', '1d')
        msg = str(ctx.exception).lower()
        self.assertIn('retired', msg)
        self.assertIn('.st', msg)

    def test_search_raises_retired(self):
        with self.assertRaises(Exception) as ctx:
            europe.search('NORDIC', 'eric')
        self.assertIn('retired', str(ctx.exception).lower())

    def test_venue_labels_retirement(self):
        venues = {v['id']: v['label'] for v in europe.venues()}
        self.assertIn('retired', venues['NORDIC'].lower())


# --- Borsa Italiana ----------------------------------------------------------


class BorsaTest(unittest.TestCase):
    def test_warmup_header_extraction(self):
        found = europe.extract_borsa_warmup(BORSA_PAGE_FIXTURE,
                                            BORSA_COOKIES_FIXTURE)
        self.assertEqual(found['jwt'], _JWT)
        self.assertEqual(found['cookies']['incap_ses_123'], 'abc')
        self.assertEqual(found['cookies']['visid_incap_456'], 'def')
        self.assertIs(found['waf_blocked'], False)

    def test_warmup_detects_waf_block(self):
        found = europe.extract_borsa_warmup(BORSA_WAF_PAGE, [])
        self.assertIs(found['waf_blocked'], True)
        self.assertIsNone(found['jwt'])
        self.assertEqual(found['cookies'], {})

    def test_warmup_block_raises_honest_reason(self):
        def blocked(url):
            return 403, [], BORSA_WAF_PAGE
        with self.assertRaises(Exception) as ctx:
            europe.candles('BORSA-IT', 'IT0000072618', '1d',
                           _fetcher=_json_fetcher(BORSA_FIXTURE),
                           _warmup_fetcher=blocked)
        self.assertIn('waf', str(ctx.exception).lower())

    def test_warmup_empty_raises(self):
        def empty(url):
            return 200, [], '<html><body>no token here</body></html>'
        with self.assertRaises(Exception) as ctx:
            europe.candles('BORSA-IT', 'IT0000072618', '1d',
                           _fetcher=_json_fetcher(BORSA_FIXTURE),
                           _warmup_fetcher=empty)
        self.assertIn('no anonymous jwt', str(ctx.exception).lower())

    def test_history_parse(self):
        bars = europe.parse_borsa(BORSA_FIXTURE)
        self.assertEqual(len(bars), 3)  # all-None row skipped
        self.assertEqual((bars[0]['o'], bars[0]['h'], bars[0]['l'],
                          bars[0]['c'], bars[0]['v']),
                         (20.0, 21.0, 19.5, 20.5, 5000.0))
        self.assertEqual(bars[-1]['v'], 0.0)  # missing volume -> 0

    def test_history_url_shape(self):
        url = europe.borsa_history_url('IT0000072618', '2024-01-01',
                                       '2024-02-01')
        self.assertIn('/api/instruments/IT0000072618/history/period', url)
        self.assertIn('resolution=D', url)

    def test_candles_round_trip_with_auth_headers(self):
        calls = []
        bars = europe.candles('BORSA-IT', 'IT0000072618', '1d', limit=10,
                              _fetcher=_json_fetcher(BORSA_FIXTURE, calls),
                              _warmup_fetcher=_warmup_ok)
        self.assertEqual(len(bars), 3)
        ts = [b['t'] for b in bars]
        self.assertEqual(ts, sorted(ts))
        url, headers = calls[0]
        self.assertIn('history/period', url)
        self.assertIn('Authorization', headers)
        self.assertTrue(headers['Authorization'].startswith('Bearer '))
        self.assertIn('incap_ses_123', headers.get('Cookie', ''))

    def test_non_isin_symbol_raises(self):
        with self.assertRaises(Exception) as ctx:
            europe.candles('BORSA-IT', 'ENI', '1d',
                           _fetcher=_json_fetcher(BORSA_FIXTURE),
                           _warmup_fetcher=_warmup_ok)
        self.assertIn('isin', str(ctx.exception).lower())

    def test_empty_raises(self):
        with self.assertRaises(Exception) as ctx:
            europe.candles('BORSA-IT', 'IT0000072618', '1d',
                           _fetcher=_json_fetcher(BORSA_EMPTY),
                           _warmup_fetcher=_warmup_ok)
        self.assertIn('history unavailable', str(ctx.exception).lower())

    def test_search_direct_isin(self):
        rows = europe.search('BORSA-IT', 'IT0000072618')
        self.assertEqual(rows, [{'symbol': 'IT0000072618',
                                 'name': 'IT0000072618 (Borsa Italiana '
                                         'direct ISIN)'}])

    def test_search_without_isin_raises(self):
        with self.assertRaises(Exception):
            europe.search('BORSA-IT', 'ENI')


# --- cross-venue contract ----------------------------------------------------


class CrossVenueTest(unittest.TestCase):
    def test_interval_rejection_names_supported(self):
        for venue, symbol in (('SIX', '1200526'), ('NORDIC', 'SSE101'),
                              ('BORSA-IT', 'IT0000072618')):
            with self.assertRaises(Exception) as ctx:
                europe.candles(venue, symbol, '1h',
                               _fetcher=_json_fetcher({}),
                               _warmup_fetcher=_warmup_ok)
            self.assertIn('unsupported interval', str(ctx.exception))
            self.assertIn('1d', str(ctx.exception))

    def test_unknown_venue_raises(self):
        with self.assertRaises(Exception) as ctx:
            europe.candles('EURONEXT', 'ACA.PA', '1d',
                           _fetcher=_json_fetcher({}))
        self.assertIn('unknown venue', str(ctx.exception))

    def test_bad_symbols_raise(self):
        for venue, symbol in (('SIX', ''), ('SIX', 'AA PL'),
                              ('NORDIC', ''), ('BORSA-IT', '')):
            with self.assertRaises(Exception, msg=(venue, symbol)):
                europe.candles(venue, symbol or 'x' if symbol == '' else
                               symbol, '1d',
                               _fetcher=_json_fetcher({}),
                               _warmup_fetcher=_warmup_ok)

    def test_limit_clamped(self):
        bars = europe.candles('SIX', '1200526', '1d', limit=0,
                              _fetcher=_json_fetcher(SIX_FIXTURE),
                              _resolve_text=lambda url: SIX_RESOLVE_CSV)
        self.assertEqual(len(bars), 1)
        with self.assertRaises(Exception):
            europe.candles('SIX', '1200526', '1d', limit='abc',
                           _fetcher=_json_fetcher(SIX_FIXTURE),
                           _resolve_text=lambda url: SIX_RESOLVE_CSV)

    def test_record_shape_all_venues(self):
        cases = [
            ('SIX', '1200526', _json_fetcher(SIX_FIXTURE), None,
             lambda url: SIX_RESOLVE_CSV),
            ('BORSA-IT', 'IT0000072618', _json_fetcher(BORSA_FIXTURE),
             _warmup_ok, None),
        ]
        for venue, symbol, fetch, warm, resolve in cases:
            with self.subTest(venue=venue):
                bars = europe.candles(venue, symbol, '1d', limit=10,
                                      _fetcher=fetch, _warmup_fetcher=warm,
                                      _resolve_text=resolve)
                self.assertGreater(len(bars), 0)
                for b in bars:
                    self.assertEqual(set(b.keys()),
                                     {'t', 'o', 'h', 'l', 'c', 'v'})
                    self.assertIsInstance(b['t'], int)
                    for k in ('o', 'h', 'l', 'c', 'v'):
                        self.assertIsInstance(b[k], float)
                    self.assertGreaterEqual(b['v'], 0)
                ts = [b['t'] for b in bars]
                self.assertEqual(ts, sorted(ts))

    def test_quote_change_math(self):
        payload = {'valors': [{'data': {
            'Date': ['20240102', '20240103', '20240104'],
            'Close': [100.0, 102.0, 105.0],
            'Open': [100.0, 102.0, 105.0],
            'Low': [100.0, 102.0, 105.0],
            'High': [100.0, 102.0, 105.0],
            'TotalVolume': [10, 20, 30]}}]}
        q = europe.quote('SIX', '1200526',
                         _fetcher=_json_fetcher(payload),
                         _resolve_text=lambda url: SIX_RESOLVE_CSV)
        self.assertEqual(q['price'], 105.0)
        self.assertEqual(q['prev_close'], 102.0)
        self.assertAlmostEqual(q['change_pct'],
                               (105.0 - 102.0) / 102.0 * 100)
        self.assertEqual(q['venue'], 'SIX')

    def test_quote_needs_two_bars(self):
        payload = {'valors': [{'data': {
            'Date': ['20240102'], 'Close': [1.0], 'Open': [1.0],
            'Low': [1.0], 'High': [1.0], 'TotalVolume': [5]}}]}
        with self.assertRaises(Exception):
            europe.quote('SIX', '1200526',
                         _fetcher=_json_fetcher(payload),
                         _resolve_text=lambda url: SIX_RESOLVE_CSV)

    def test_fetcher_errors_surface(self):
        def boom(url, headers=None):
            raise Exception('rate limited (429), retry shortly')
        with self.assertRaises(Exception) as ctx:
            europe.candles('SIX', '1200526', '1d', _fetcher=boom,
                           _resolve_text=lambda url: SIX_RESOLVE_CSV)
        self.assertIn('rate limited', str(ctx.exception))


if __name__ == '__main__':
    unittest.main()

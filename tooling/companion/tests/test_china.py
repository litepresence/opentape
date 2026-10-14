"""Offline unit tests for tooling/companion/sources/china.py (workstream H).

Fully offline: pure mapping/normalize functions use inline fixtures
(DataFrame-likes as plain lists/dicts — no pandas, no pip deps), and the
live-backend paths are exercised through sys.modules stubs (fake baostock /
akshare modules), never the network. Live probes are documented as notes
only (see LIVE NOTES at the bottom) and never gate tests.
"""
import contextlib
import datetime
import importlib.util
import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_CHINA_PATH = os.path.normpath(os.path.join(_HERE, '..', 'sources', 'china.py'))

_ABSENT = object()


def _load(name='china_source'):
    spec = importlib.util.spec_from_file_location(name, _CHINA_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


china = _load()


@contextlib.contextmanager
def _stubbed(**stubs):
    """Temporarily set sys.modules entries, then load a fresh china module.

    Use value None to simulate a missing (unimportable) backend:
    ``import x`` raises ImportError when sys.modules['x'] is None.
    """
    saved = {}
    for key, val in stubs.items():
        saved[key] = sys.modules.get(key, _ABSENT)
        sys.modules[key] = val
    try:
        yield _load()
    finally:
        for key, val in saved.items():
            if val is _ABSENT:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = val


class _FakeLogin(object):
    def __init__(self, code='0', msg=''):
        self.error_code = code
        self.error_msg = msg


class _FakeRS(object):
    """Mimics baostock ResultData: error_code, next(), get_row_data(), fields."""

    def __init__(self, fields, rows, error_code='0', error_msg=''):
        self.fields = fields
        self._rows = rows
        self.error_code = error_code
        self.error_msg = error_msg
        self._i = -1

    def next(self):
        self._i += 1
        return self._i < len(self._rows)

    def get_row_data(self):
        return self._rows[self._i]


def _fake_baostock(rows=None, fields=None, query_code='0', login_code='0', box=None):
    box = {} if box is None else box
    if fields is None:
        fields = ['date', 'code', 'open', 'high', 'low', 'close', 'volume',
                  'amount', 'adjustflag']
    if rows is None:
        rows = [
            ['2024-01-02', 'sh.600000', '10.0', '10.5', '9.9', '10.2',
             '1000', '10200', '2'],
            ['2024-01-03', 'sh.600000', '10.2', '10.8', '10.1', '10.6',
             '1200', '12720', '2'],
        ]
    mod = types.ModuleType('baostock')

    def login():
        box['logins'] = box.get('logins', 0) + 1
        return _FakeLogin(code=login_code)

    def logout():
        box['logouts'] = box.get('logouts', 0) + 1

    def query_history_k_data_plus(**kw):
        box['query_kw'] = kw
        return _FakeRS(fields, rows, error_code=query_code,
                       error_msg='' if query_code == '0' else 'upstream says no')

    mod.login = login
    mod.logout = logout
    mod.query_history_k_data_plus = query_history_k_data_plus
    return mod


def _fake_akshare(box=None, hist_rows=None, registry_rows=None, spot_rows=None):
    box = {} if box is None else box
    if hist_rows is None:
        hist_rows = [
            {'日期': '2024-01-02', '开盘': 10.0, '收盘': 10.2, '最高': 10.5,
             '最低': 9.9, '成交量': 500.0},
        ]
    if registry_rows is None:
        registry_rows = [
            {'code': '600000', 'name': '浦发银行'},
            {'code': '000001', 'name': '平安银行'},
        ]
    if spot_rows is None:
        spot_rows = [
            {'代码': '600000', '名称': '浦发银行', '最新价': 10.5,
             '最高': 10.6, '最低': 10.1, '今开': 10.2, '昨收': 10.0,
             '成交量': 12345.0},
        ]
    mod = types.ModuleType('akshare')

    def stock_zh_a_hist(**kw):
        box['hist_kw'] = kw
        return list(hist_rows)

    def stock_zh_a_hist_min_em(**kw):
        box['min_kw'] = kw
        return list(hist_rows)

    def stock_info_a_code_name():
        box['registry_calls'] = box.get('registry_calls', 0) + 1
        return list(registry_rows)

    def stock_zh_a_spot_em():
        return list(spot_rows)

    mod.stock_zh_a_hist = stock_zh_a_hist
    mod.stock_zh_a_hist_min_em = stock_zh_a_hist_min_em
    mod.stock_info_a_code_name = stock_info_a_code_name
    mod.stock_zh_a_spot_em = stock_zh_a_spot_em
    return mod


class ContractTest(unittest.TestCase):
    def test_source_constants(self):
        self.assertEqual(china.SOURCE, 'china')
        self.assertEqual(china.LABEL, 'China A-shares')
        self.assertEqual(
            china.INTERVALS,
            ['5m', '15m', '30m', '1h', '1d', '1wk', '1mo'],
        )
        self.assertNotIn('1m', china.INTERVALS)
        self.assertEqual(
            china.STREAM,
            {'mode': 'snapshot', 'cadence': 300,
             'note': 'T+1 EOD; intraday delayed'},
        )

    def test_venues(self):
        venues = china.venues()
        ids = {v['id'] for v in venues}
        self.assertIn('CN-A', ids)
        self.assertIn('HK', ids)
        for v in venues:
            self.assertIn('id', v)
            self.assertIn('label', v)


class RoutingTest(unittest.TestCase):
    def test_prefixed_routes(self):
        self.assertEqual(china.route_code('sh.600000'), {
            'canonical': 'sh.600000', 'baostock': 'sh.600000',
            'akshare': '600000', 'exchange': 'SSE',
        })
        self.assertEqual(china.route_code('sz.000001')['exchange'], 'SZSE')
        self.assertEqual(china.route_code('sz.300750')['akshare'], '300750')
        self.assertEqual(china.route_code('bj.430047')['exchange'], 'BSE')
        self.assertEqual(china.baostock_code_for('SH.600000'), 'sh.600000')
        self.assertEqual(china.akshare_symbol_for('sz.000001'), '000001')

    def test_bare_code_guess(self):
        self.assertEqual(china.canonical_symbol('600000'), 'sh.600000')
        self.assertEqual(china.canonical_symbol('000001'), 'sz.000001')
        self.assertEqual(china.canonical_symbol('300750'), 'sz.300750')
        self.assertEqual(china.canonical_symbol('430047'), 'bj.430047')

    def test_bad_symbols_rejected(self):
        for bad in ('', 'zzz', 'sh.6000', '60000', 'sh.abcdef',
                    'sh.000001', 'sz.600000', 'bj.600000', '600000.SH',
                    '1234567', None):
            with self.assertRaises(Exception, msg='symbol %r' % (bad,)):
                china.canonical_symbol(bad)


class IntervalTest(unittest.TestCase):
    def test_frequency_map(self):
        self.assertEqual(china.baostock_frequency_for('5m'), '5')
        self.assertEqual(china.baostock_frequency_for('15m'), '15')
        self.assertEqual(china.baostock_frequency_for('30m'), '30')
        self.assertEqual(china.baostock_frequency_for('1h'), '60')
        self.assertEqual(china.baostock_frequency_for('1d'), 'd')
        self.assertEqual(china.baostock_frequency_for('1wk'), 'w')
        self.assertEqual(china.baostock_frequency_for('1mo'), 'm')

    def test_interval_rejection_lists_supported(self):
        with self.assertRaises(Exception) as ctx:
            china.validate_interval('1m')
        msg = str(ctx.exception)
        self.assertIn('1m', msg)
        self.assertIn('supported', msg)
        for iv in china.INTERVALS:
            self.assertIn(iv, msg)

    def test_candles_rejects_1m_before_backend(self):
        # Must reject even with no backends installed (validate first).
        with _stubbed(baostock=None, akshare=None) as mod:
            with self.assertRaises(Exception) as ctx:
                mod.candles('CN-A', 'sh.600000', '1m')
            self.assertIn('supported', str(ctx.exception))

    def test_window_math(self):
        start, end = china.build_baostock_window(
            datetime.date(2024, 1, 10), '1d', 5)
        self.assertEqual((start, end), ('2023-12-21', '2024-01-10'))
        start, end = china.build_baostock_window(
            datetime.date(2024, 1, 10), '1wk', 4)
        self.assertEqual(end, '2024-01-10')
        self.assertLess(start, '2024-01-01')


class NormalizeTest(unittest.TestCase):
    def test_chinese_columns(self):
        rows = [
            {'日期': '2024-01-03', '开盘': 10.2, '收盘': 10.6, '最高': 10.8,
             '最低': 10.1, '成交量': 600.0},
            {'日期': '2024-01-02', '开盘': 10.0, '收盘': 10.2, '最高': 10.5,
             '最低': 9.9, '成交量': 500.0},
        ]
        bars = china.normalize_rows(rows)
        self.assertEqual(
            bars,
            [
                {'t': 1704153600000, 'o': 10.0, 'h': 10.5, 'l': 9.9,
                 'c': 10.2, 'v': 500.0},
                {'t': 1704240000000, 'o': 10.2, 'h': 10.8, 'l': 10.1,
                 'c': 10.6, 'v': 600.0},
            ],
        )

    def test_baostock_english_and_minute_date_time(self):
        rows = [
            {'date': '2024-01-02', 'time': '09:35:00', 'code': 'sh.600000',
             'open': '10.0', 'high': '10.5', 'low': '9.9', 'close': '10.2',
             'volume': '1000', 'amount': '10200', 'adjustflag': '2'},
        ]
        bars = china.normalize_rows(rows)
        self.assertEqual(len(bars), 1)
        # 09:35 Asia/Shanghai == 01:35 UTC.
        self.assertEqual(bars[0]['t'], 1704159300000)
        self.assertEqual(bars[0]['o'], 10.0)
        self.assertEqual(bars[0]['v'], 1000.0)

    def test_skips_bad_rows_and_defaults_volume(self):
        rows = [
            {'date': '2024-01-02', 'open': '', 'high': 1.0, 'low': 1.0,
             'close': 1.0, 'volume': 5.0},  # suspended day: skip
            {'date': 'not-a-date', 'open': 1.0, 'high': 1.0, 'low': 1.0,
             'close': 1.0},  # bad time: skip
            {'date': '2024-01-03', 'open': 1.0, 'high': 2.0, 'low': 0.5,
             'close': 1.5},  # no volume: 0.0
            'garbage',
        ]
        bars = china.normalize_rows(rows)
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0]['t'], 1704240000000)
        self.assertEqual(bars[0]['v'], 0.0)

    def test_parse_time_forms(self):
        self.assertEqual(china.parse_time_to_ms('2024-01-02'), 1704153600000)
        self.assertEqual(china.parse_time_to_ms('20240102'), 1704153600000)
        self.assertEqual(
            china.parse_time_to_ms(datetime.date(2024, 1, 2)), 1704153600000)
        self.assertEqual(china.parse_time_to_ms(1704153600000), 1704153600000)
        self.assertEqual(china.parse_time_to_ms(1704153600), 1704153600000)
        with self.assertRaises(ValueError):
            china.parse_time_to_ms('')
        with self.assertRaises(ValueError):
            china.parse_time_to_ms('not-a-date')


class BackendMissingTest(unittest.TestCase):
    def test_module_imports_without_backends(self):
        with _stubbed(baostock=None, akshare=None) as mod:
            self.assertIsNone(mod._bs)
            self.assertIsNone(mod._ak)
            self.assertEqual(mod.SOURCE, 'china')

    def test_candles_reports_backend_missing_with_hint(self):
        with _stubbed(baostock=None, akshare=None) as mod:
            with self.assertRaises(Exception) as ctx:
                mod.candles('CN-A', 'sh.600000', '1d')
            msg = str(ctx.exception)
            self.assertIn('backend missing', msg)
            self.assertIn('pip install', msg)
            self.assertIn('baostock', msg)
            self.assertIn('akshare', msg)


class BaostockPathTest(unittest.TestCase):
    def test_adjustflag_pass_through_and_shape(self):
        box = {}
        fake_bs = _fake_baostock(box=box)
        with _stubbed(baostock=fake_bs, akshare=None) as mod:
            bars = mod.candles('CN-A', 'sh.600000', '1d', limit=5)
            kw = box['query_kw']
            self.assertEqual(kw['code'], 'sh.600000')
            self.assertEqual(kw['frequency'], 'd')
            self.assertEqual(kw['adjustflag'], mod.BAOSTOCK_ADJUSTFLAG)
            self.assertEqual(kw['adjustflag'], '2')
            self.assertIn('start_date', kw)
            self.assertIn('end_date', kw)
            self.assertEqual(len(bars), 2)
            self.assertLess(bars[0]['t'], bars[1]['t'])
            self.assertEqual(bars[0]['o'], 10.0)
            self.assertEqual(box.get('logouts'), 1)

    def test_intraday_frequency_and_fields(self):
        box = {}
        fields = ['date', 'time', 'code', 'open', 'high', 'low', 'close',
                  'volume', 'amount', 'adjustflag']
        rows = [
            ['2024-01-02', '09:35:00', 'sz.000001', '10.0', '10.1', '9.9',
             '10.05', '200', '2010', '2'],
        ]
        fake_bs = _fake_baostock(rows=rows, fields=fields, box=box)
        with _stubbed(baostock=fake_bs, akshare=None) as mod:
            bars = mod.candles('CN-A', 'sz.000001', '5m')
            self.assertEqual(box['query_kw']['frequency'], '5')
            self.assertEqual(box['query_kw']['adjustflag'], '2')
            self.assertIn('time', box['query_kw']['fields'])
            self.assertEqual(len(bars), 1)
            self.assertEqual(bars[0]['t'], 1704159300000)

    def test_limit_trim(self):
        box = {}
        fake_bs = _fake_baostock(box=box)
        with _stubbed(baostock=fake_bs, akshare=None) as mod:
            bars = mod.candles('CN-A', 'sh.600000', '1d', limit=1)
            self.assertEqual(len(bars), 1)
            self.assertEqual(bars[0]['c'], 10.6)  # keeps the latest

    def test_baostock_mismatch_raises_clearly(self):
        bare = types.ModuleType('baostock')  # no query fn: API mismatch
        bare.login = lambda: _FakeLogin()
        bare.logout = lambda: None
        with _stubbed(baostock=bare, akshare=None) as mod:
            with self.assertRaises(Exception) as ctx:
                mod.candles('CN-A', 'sh.600000', '1d')
            self.assertIn('mismatch', str(ctx.exception))


class AkshareFallbackTest(unittest.TestCase):
    def test_falls_back_when_baostock_errors(self):
        box = {}
        fake_bs = _fake_baostock(query_code='1', box={})
        fake_ak = _fake_akshare(box=box)
        with _stubbed(baostock=fake_bs, akshare=fake_ak) as mod:
            bars = mod.candles('CN-A', 'sh.600000', '1d')
            self.assertEqual(len(bars), 1)
            self.assertEqual(bars[0]['t'], 1704153600000)
            kw = box['hist_kw']
            self.assertEqual(kw['symbol'], '600000')  # bare code convention
            self.assertEqual(kw['period'], 'daily')
            self.assertEqual(kw['adjust'], 'qfq')

    def test_minute_fallback_uses_min_em(self):
        box = {}
        fake_bs = _fake_baostock(query_code='1', box={})
        hist = [{'时间': '2024-01-02 09:35:00', '开盘': 10.0, '收盘': 10.05,
                 '最高': 10.1, '最低': 9.9, '成交量': 200.0}]
        fake_ak = _fake_akshare(box=box, hist_rows=hist)
        with _stubbed(baostock=fake_bs, akshare=fake_ak) as mod:
            bars = mod.candles('CN-A', 'sz.000001', '15m')
            self.assertEqual(box['min_kw']['period'], '15')
            self.assertEqual(box['min_kw']['symbol'], '000001')
            self.assertEqual(len(bars), 1)

    def test_both_fail_reports_both(self):
        fake_bs = _fake_baostock(query_code='1', box={})
        fake_ak = _fake_akshare(box={}, hist_rows=[])
        with _stubbed(baostock=fake_bs, akshare=fake_ak) as mod:
            with self.assertRaises(Exception) as ctx:
                mod.candles('CN-A', 'sh.600000', '1d')
            self.assertIn('baostock', str(ctx.exception))
            self.assertIn('akshare', str(ctx.exception))


class VenueTest(unittest.TestCase):
    def test_hk_points_to_yahoo(self):
        with self.assertRaises(Exception) as ctx:
            china.candles('HK', 'sh.600000', '1d')
        msg = str(ctx.exception)
        self.assertIn('HK', msg)
        self.assertIn('yahoo', msg)

    def test_unknown_venue(self):
        with self.assertRaises(Exception) as ctx:
            china.candles('NYSE', 'sh.600000', '1d')
        self.assertIn('unknown venue', str(ctx.exception))


class SearchTest(unittest.TestCase):
    def test_pattern_matcher_full_and_bare(self):
        with _stubbed(baostock=None, akshare=None) as mod:
            self.assertEqual(
                mod.search('CN-A', 'sh.600000'),
                [{'symbol': 'sh.600000', 'name': 'sh.600000'}],
            )
            self.assertEqual(
                mod.search('CN-A', '600000'),
                [{'symbol': 'sh.600000', 'name': 'sh.600000'}],
            )
            self.assertEqual(
                mod.search('CN-A', '000001')[0]['symbol'], 'sz.000001')

    def test_pattern_matcher_partial_and_names_need_registry(self):
        with _stubbed(baostock=None, akshare=None) as mod:
            self.assertEqual(mod.search('CN-A', '6000'), [])
            self.assertEqual(mod.search('CN-A', 'hello'), [])
            self.assertEqual(mod.search('CN-A', ''), [])
            self.assertEqual(mod.search('CN-A', 'sh.000001'), [])

    def test_ambiguous_bare_code_yields_guesses(self):
        with _stubbed(baostock=None, akshare=None) as mod:
            guesses = mod.search('CN-A', '700001')
            self.assertEqual(
                [g['symbol'] for g in guesses],
                ['sh.700001', 'sz.700001', 'bj.700001'],
            )

    def test_registry_path_when_akshare_present(self):
        box = {}
        fake_ak = _fake_akshare(box=box)
        with _stubbed(baostock=None, akshare=fake_ak) as mod:
            hits = mod.search('CN-A', '6000')
            self.assertEqual(
                hits, [{'symbol': 'sh.600000', 'name': '浦发银行'}])
            hits = mod.search('CN-A', '平安')
            self.assertEqual(
                hits, [{'symbol': 'sz.000001', 'name': '平安银行'}])
            self.assertEqual(box.get('registry_calls'), 2)

    def test_registry_failure_falls_back_to_pattern(self):
        fake_ak = _fake_akshare()
        def boom():
            raise RuntimeError('upstream down')
        fake_ak.stock_info_a_code_name = boom
        with _stubbed(baostock=None, akshare=fake_ak) as mod:
            self.assertEqual(
                mod.search('CN-A', '600000'),
                [{'symbol': 'sh.600000', 'name': 'sh.600000'}],
            )


class QuoteTest(unittest.TestCase):
    def test_quote_missing_backend(self):
        with _stubbed(baostock=None, akshare=None) as mod:
            with self.assertRaises(Exception) as ctx:
                mod.quote('CN-A', 'sh.600000')
            self.assertIn('backend missing', str(ctx.exception))

    def test_quote_from_spot_snapshot(self):
        fake_ak = _fake_akshare()
        with _stubbed(baostock=None, akshare=fake_ak) as mod:
            q = mod.quote('CN-A', 'sh.600000')
            self.assertEqual(q['symbol'], 'sh.600000')
            self.assertEqual(q['price'], 10.5)
            self.assertEqual(q['name'], '浦发银行')
            self.assertEqual(q['open'], 10.2)
            self.assertEqual(q['prev_close'], 10.0)
            with self.assertRaises(Exception):
                mod.quote('CN-A', 'sz.000001')  # absent from snapshot


if __name__ == '__main__':
    unittest.main()


# LIVE NOTES (not executed — record-only, 2026-10-14):
# - baostock 0.9.4 API verified from the published wheel (login/logout/
#   query_history_k_data_plus(code, fields, start_date, end_date,
#   frequency, adjustflag); minute fields carry date+time; adjustflag
#   "2"=前复权). Spot probe skipped: baostock requires a login session.
# - akshare 1.18.88 signatures verified from the published wheel
#   (stock_zh_a_hist symbol/period/start_date/end_date/adjust; min_em
#   period '1|5|15|30|60'; spot_em/code_name argless with the column sets
#   mapped in china.py). Live HTTP probes skipped (offline task lane).

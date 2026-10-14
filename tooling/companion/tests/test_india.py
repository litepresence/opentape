"""Offline fixture tests for tooling/companion/sources/india.py.

Stdlib unittest only. No network access: the MCP chaining test uses a
fake client, CSV/ZIP/NAV tests use inline fixtures, and the search test
forces the local NIFTY fallback by stubbing the MCP search call.
"""

import importlib.util
import io
import json
import unittest
import zipfile
from datetime import date
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / 'sources' / 'india.py'
_spec = importlib.util.spec_from_file_location('india_source', _SRC)
india = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(india)


def _day_ms(iso):
    y, m, d = (int(p) for p in iso.split('-'))
    from datetime import datetime, timezone
    return int(datetime(y, m, d, tzinfo=timezone.utc).timestamp() * 1000)


SSE_TWO_FRAMES = (
    ': comment line\r\n'
    'event: message\r\n'
    'data: {"jsonrpc": "2.0", "id": 2, "result": '
    '{"history": [{"date": "12-Oct-2026", "open": 100, "high": 101, '
    '"low": 99, "close": 100.5, "volume": 1000}], '
    '"next_end_date": "12-Jul-2026"}}\r\n'
    '\r\n'
    'event:message\n'
    'data: {"jsonrpc":"2.0","id":2,"result":{"history":[],"next_end_date":null}}\n'
    '\n'
)

SSE_ERROR = (
    'event: message\n'
    'data: {"jsonrpc": "2.0", "id": 2, '
    '"error": {"code": -32602, "message": "bad symbol"}}\n'
    '\n'
)

IND_CLOSE_ALL = (
    'SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,'
    'TOTTRDVAL,TIMESTAMP,TOTALTRADES,ISIN\r\n'
    'RELIANCE,EQ,2500.00,2520.50,2490.00,2515.25,2514.00,2498.00,'
    '1234567,3100000000.00,12-OCT-2026,45000,INE002A01018\r\n'
    'RELIANCE,BE,2501.00,2519.00,2491.00,2514.00,2513.00,2498.00,'
    '1000,2514000.00,12-OCT-2026,50,INE002A01018\r\n'
    'TCS,EQ,3100.00,3120.00,3090.00,3115.00,3114.00,3095.00,'
    '234567,730000000.00,12-OCT-2026,12000,INE467B01029\r\n'
)

BSE_BHAV = (
    'SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,OPEN,HIGH,LOW,CLOSE,LAST,'
    'PREVCLOSE,NO_TRADES,NO_OF_SHRS,NET_TURNOV,TDCLOINDI\r\n'
    '500325,RELIANCE,A,Q,2500.00,2520.50,2490.00,2515.25,2514.00,'
    '2498.00,45000,1234567,3100000000.00,*\r\n'
)

NAV_ALL = (
    'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;'
    'Scheme Name;Net Asset Value;Date\r\n'
    '119062;INF769K01DM9;INF769K01DN7;Parag Parikh Flexi Cap Fund - '
    'Growth;82.1234;10-Oct-2026\r\n'
    '120586;INF174K01LS2;INF174K01LT0;Axis Bluechip Fund - Growth;'
    '55.5000;10-Oct-2026\r\n'
)

MFAPI_PAYLOAD = {
    'meta': {'fund_house': 'Parag Parikh', 'scheme_code': 119062},
    'data': [
        {'date': '08-10-2026', 'nav': '81.9000'},
        {'date': '09-10-2026', 'nav': '82.0000'},
        {'date': '10-10-2026', 'nav': '82.1234'},
    ],
    'status': 'SUCCESS',
}

MCX_BHAV = (
    'Symbol,Expiry,Open,High,Low,Close,Volume,OpenInterest,Date\r\n'
    'GOLD,05FEB2026,98000,98500,97900,98400,12000,8000,12-10-2026\r\n'
    'GOLD,05APR2026,99000,99500,98900,99400,3000,5000,12-10-2026\r\n'
    'SILVER,05DEC2025,110000,111000,109500,110500,9000,7000,12-10-2026\r\n'
)


class FakeMcpClient(object):
    """Two history pages with overlap, chained via next_end_date."""

    def __init__(self):
        self.calls = []

    def call(self, tool, args):
        self.calls.append((tool, dict(args)))
        assert args.get('months', 3) <= 3, 'months must be clamped <= 3'
        if args.get('endDate'):
            return {'history': [
                {'date': '12-Jul-2026', 'open': 90, 'high': 92,
                 'low': 89, 'close': 91, 'volume': 500}],
                'next_end_date': None}
        return {'history': [
            {'date': '12-Oct-2026', 'open': 100, 'high': 101,
             'low': 99, 'close': 100.5, 'volume': 1000},
            {'date': '12-Jul-2026', 'open': 90, 'high': 91,
             'low': 89, 'close': 90.5, 'volume': 400}],
            'next_end_date': '12-Jul-2026'}


class TestContract(unittest.TestCase):
    def test_constants(self):
        self.assertEqual(india.SOURCE, 'india')
        self.assertEqual(india.LABEL, 'India (NSE/BSE/MCX)')
        self.assertEqual(india.INTERVALS, ['1d'])
        self.assertEqual(india.STREAM['mode'], 'snapshot')
        self.assertEqual(india.STREAM['cadence'], 300)

    def test_venues(self):
        venues = india.venues()
        self.assertEqual([v['id'] for v in venues],
                         ['NSE', 'BSE', 'MCX', 'MF-NAV'])
        for v in venues:
            self.assertIn('label', v)

    def test_interval_rejection(self):
        for bad in ('1h', '1m', '1wk', '5m'):
            with self.assertRaises(Exception) as ctx:
                india.candles('NSE', 'RELIANCE', bad, 10)
            self.assertIn("['1d']", str(ctx.exception))

    def test_unknown_venue(self):
        with self.assertRaises(Exception) as ctx:
            india.candles('NYSE', 'AAPL', '1d', 10)
        self.assertIn('unknown venue', str(ctx.exception))

    def test_ncdex_unsupported(self):
        with self.assertRaises(Exception) as ctx:
            india.candles('NCDEX', 'CHANA', '1d', 10)
        self.assertIn('unsupported market', str(ctx.exception))
        with self.assertRaises(Exception) as ctx2:
            india.search('NCDEX', 'CHANA')
        self.assertIn('unsupported market', str(ctx2.exception))

    def test_bad_symbol(self):
        with self.assertRaises(Exception):
            india._clean_symbol('RELIANCE; DROP TABLE')
        with self.assertRaises(Exception):
            india._clean_symbol('x' * 65)


class TestMcpSse(unittest.TestCase):
    def test_parse_sse_frames(self):
        frames = india.parse_sse(SSE_TWO_FRAMES)
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0]['event'], 'message')
        payload = json.loads(frames[0]['data'])
        self.assertIn('result', payload)

    def test_sse_results_unwrap(self):
        results = india.sse_jsonrpc_results(SSE_TWO_FRAMES)
        self.assertEqual(len(results), 2)
        self.assertIn('history', results[0])
        self.assertEqual(results[0]['history'][0]['close'], 100.5)
        self.assertIsNone(results[1]['next_end_date'])

    def test_sse_error_raises(self):
        with self.assertRaises(Exception) as ctx:
            india.sse_jsonrpc_results(SSE_ERROR)
        self.assertIn('bad symbol', str(ctx.exception))

    def test_decode_plain_json(self):
        body = json.dumps({'jsonrpc': '2.0', 'id': 2, 'result': {
            'content': [{'type': 'text',
                         'text': json.dumps({'history': [], 'ok': True})}]}
        }).encode('utf-8')
        self.assertEqual(india.decode_mcp_response(body),
                         {'history': [], 'ok': True})

    def test_decode_sse_body(self):
        result = india.decode_mcp_response(SSE_TWO_FRAMES.encode('utf-8'))
        # two result frames -> list
        self.assertEqual(len(result), 2)
        self.assertIn('history', result[0])

    def test_missing_session_header(self):
        lowered = india._lower_headers({'Content-Type': 'application/json'})
        self.assertIsNone(lowered.get('mcp-session-id'))


class TestHistoryChaining(unittest.TestCase):
    def test_chained_merge(self):
        fake = FakeMcpClient()
        rows = india.fetch_stock_history('RELIANCE', _client=fake)
        self.assertEqual([c['t'] for c in rows],
                         sorted(c['t'] for c in rows))
        # overlap on 12-Jul: later (second) page wins -> close 91
        by_t = {c['t']: c for c in rows}
        self.assertEqual(by_t[_day_ms('2026-07-12')]['c'], 91.0)
        self.assertEqual(by_t[_day_ms('2026-10-12')]['c'], 100.5)
        self.assertEqual(fake.calls[1][1]['endDate'], '12-Jul-2026')

    def test_months_clamped(self):
        self.assertEqual(india.clamp_months(12), 3)
        self.assertEqual(india.clamp_months(0), 1)
        fake = FakeMcpClient()
        india.fetch_stock_history('RELIANCE', months=99, _client=fake)
        self.assertEqual(fake.calls[0][1]['months'], 3)

    def test_merge_prefers_later_page(self):
        a = [{'t': 1, 'o': 1, 'h': 1, 'l': 1, 'c': 1, 'v': 1}]
        b = [{'t': 1, 'o': 2, 'h': 2, 'l': 2, 'c': 2, 'v': 2},
             {'t': 3, 'o': 3, 'h': 3, 'l': 3, 'c': 3, 'v': 3}]
        merged = india.merge_history_pages([a, b])
        self.assertEqual([c['t'] for c in merged], [1, 3])
        self.assertEqual(merged[0]['c'], 2)

    def test_row_spellings(self):
        row = india.normalize_history_row(
            {'TIMESTAMP': '12-OCT-2026', 'OPEN': '1,000', 'HIGH': 2,
             'LOW': 0.5, 'CLOSE': 1.5, 'TOTTRDQTY': '10,000'})
        self.assertEqual(row['t'], _day_ms('2026-10-12'))
        self.assertEqual((row['o'], row['h'], row['l'], row['c'], row['v']),
                         (1000.0, 2.0, 0.5, 1.5, 10000.0))

    def test_date_t_inside_month_name(self):
        # Regression: the 'T' in 'OCT' must not be treated as an ISO
        # date/time separator.
        self.assertEqual(india.date_to_ms('12-OCT-2026'),
                         _day_ms('2026-10-12'))
        self.assertEqual(india.date_to_ms('2026-10-12T00:00:00'),
                         _day_ms('2026-10-12'))
        with self.assertRaises(Exception):
            india.date_to_ms('not-a-date')


class TestArchives(unittest.TestCase):
    def test_ind_close_all(self):
        table = india.parse_ind_close_all(IND_CLOSE_ALL)
        self.assertEqual(table['RELIANCE']['c'], 2515.25)
        # SERIES preference: EQ row wins over BE
        self.assertEqual(table['RELIANCE']['series'], 'EQ')
        self.assertEqual(table['RELIANCE']['v'], 1234567.0)
        self.assertEqual(table['TCS']['o'], 3100.0)

    def test_bhavcopy_zip_roundtrip(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('cm12OCT2026bhav.csv', IND_CLOSE_ALL)
        table = india.parse_bhavcopy_zip(buf.getvalue())
        self.assertEqual(table['TCS']['h'], 3120.0)

    def test_bhavcopy_zip_bad(self):
        with self.assertRaises(Exception):
            india.parse_bhavcopy_zip(b'not a zip')
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('note.txt', 'hi')
        with self.assertRaises(Exception):
            india.parse_bhavcopy_zip(buf.getvalue())

    def test_bse_bhav_parse(self):
        table = india.parse_equity_bhavcopy(BSE_BHAV)
        self.assertEqual(table['500325']['c'], 2515.25)
        self.assertEqual(table['500325']['name'], 'RELIANCE')

    def test_series_builder_skips_weekends(self):
        seen = []

        def fetch_day(day):
            seen.append(day)
            if day == date(2026, 10, 12):  # a Monday
                return {'o': 1, 'h': 2, 'l': 0.5, 'c': 1.5, 'v': 10}
            return None

        out = india.build_series_from_daily(fetch_day, 1,
                                            start=date(2026, 10, 14))
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['t'], _day_ms('2026-10-12'))
        for day in seen:
            self.assertLess(day.weekday(), 5)

    def test_series_builder_empty_raises(self):
        with self.assertRaises(Exception) as ctx:
            india.build_series_from_daily(lambda day: None, 5,
                                          start=date(2026, 10, 14))
        self.assertIn('no data', str(ctx.exception))


class TestCorporateActions(unittest.TestCase):
    def test_split_adjustment(self):
        candles = [
            {'t': _day_ms('2026-01-05'), 'o': 200, 'h': 210,
             'l': 190, 'c': 205, 'v': 100},
            {'t': _day_ms('2026-02-05'), 'o': 100, 'h': 105,
             'l': 95, 'c': 102, 'v': 200},
        ]
        actions = india.parse_corporate_actions([
            {'type': 'SPLIT', 'ex_date': '20-Jan-2026', 'ratio': '2:1'}])
        self.assertEqual(actions[0]['factor'], 0.5)
        adj = india.apply_adjustments(candles, actions)
        self.assertEqual(adj[0]['c'], 102.5)   # pre-ex halved
        self.assertEqual(adj[1]['c'], 102.0)   # post-ex untouched

    def test_dividend_keeps_factor_one(self):
        actions = india.parse_corporate_actions(
            {'actions': [{'type': 'DIVIDEND', 'ex_date': '01-01-2026'}]})
        self.assertEqual(actions[0]['factor'], 1.0)
        candles = [{'t': 1, 'o': 5, 'h': 5, 'l': 5, 'c': 5, 'v': 1}]
        self.assertEqual(india.apply_adjustments(candles, actions), candles)

    def test_holiday_parse(self):
        days = india.parse_holiday_master(
            {'holidays': [{'date': '26-Jan-2026'}, {'date': 'bad-date'}]})
        self.assertEqual(days, [_day_ms('2026-01-26')])


class TestNav(unittest.TestCase):
    def test_nav_all_parse(self):
        funds = india.parse_nav_all(NAV_ALL)
        self.assertIn('119062', funds)
        self.assertEqual(funds['119062']['points'][0][1], 82.1234)

    def test_nav_all_code_filter(self):
        points = india.parse_nav_all(NAV_ALL, '120586')
        self.assertEqual(points, [('10-Oct-2026', 55.5)])
        with self.assertRaises(Exception):
            india.parse_nav_all(NAV_ALL, '000000')

    def test_mfapi_parse(self):
        candles = india.parse_mfapi_history(MFAPI_PAYLOAD)
        self.assertEqual(len(candles), 3)
        self.assertEqual([c['t'] for c in candles],
                         sorted(c['t'] for c in candles))
        for c in candles:
            self.assertEqual((c['o'], c['h'], c['l']), (c['c'], c['c'], c['c']))
            self.assertEqual(c['v'], 0.0)
        self.assertEqual(candles[-1]['c'], 82.1234)

    def test_mfapi_status_rejected(self):
        with self.assertRaises(Exception):
            india.parse_mfapi_history({'status': 'FAIL', 'data': []})

    def test_nav_points_to_candles(self):
        out = india.nav_points_to_candles(
            [('10-Oct-2026', 55.5), ('08-Oct-2026', 54.0),
             ('bad-date', 1.0)], limit=10)
        self.assertEqual([c['c'] for c in out], [54.0, 55.5])


class TestMcx(unittest.TestCase):
    def test_parse(self):
        rows = india.parse_mcx_bhavcopy(MCX_BHAV)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]['c'], 98400.0)
        self.assertEqual(rows[0]['oi'], 8000.0)

    def test_nearest_expiry(self):
        rows = india.parse_mcx_bhavcopy(MCX_BHAV)
        label, picked = india.nearest_expiry(rows, 'gold')
        self.assertEqual(label, '05FEB2026')
        self.assertEqual(len(picked), 1)
        with self.assertRaises(Exception):
            india.nearest_expiry(rows, 'NICKEL')

    def test_series_from_fake_days(self):
        def fetch_day(day):
            return MCX_BHAV.replace('12-10-2026', day.strftime('%d-%m-%Y'))

        out = india.fetch_mcx_series('GOLD', limit=2,
                                     start=date(2026, 10, 14),
                                     _fetch_day=fetch_day)
        self.assertEqual(len(out), 2)
        self.assertLess(out[0]['t'], out[1]['t'])
        self.assertEqual(out[0]['c'], 98400.0)  # nearest-expiry settle


class TestSearch(unittest.TestCase):
    def test_nse_fallback_offline(self):
        real = india._mcp_search
        india._mcp_search = lambda q, timeout=8: (_ for _ in ()).throw(
            Exception('offline'))
        try:
            found = india.search('NSE', 'reli')
        finally:
            india._mcp_search = real
        symbols = [r['symbol'] for r in found]
        self.assertIn('RELIANCE', symbols)

    def test_local_filter_ranking(self):
        out = india.filter_local_symbols('rel', india.NIFTY_50)
        self.assertEqual(out[0]['symbol'], 'RELIANCE')
        self.assertEqual(india.filter_local_symbols('', india.NIFTY_50), [])

    def test_mcx_search_local(self):
        out = india.search('MCX', 'gold')
        self.assertEqual(out[0]['symbol'], 'GOLD')

    def test_bse_search_local(self):
        out = india.search('BSE', '500325')
        self.assertEqual(out[0]['symbol'], '500325')


if __name__ == '__main__':
    unittest.main()

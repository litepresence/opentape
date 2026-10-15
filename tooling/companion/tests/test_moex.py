"""Offline unit tests for tooling/companion/sources/moex.py.

Fully offline: every test uses inline ISS-shaped fixtures or injected fake
fetchers, no network. Live spot-checks are notes only (see LIVE NOTES at
the bottom) and never gate tests.
"""
import importlib.util
import os
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOEX_PATH = os.path.normpath(os.path.join(_HERE, '..', 'sources', 'moex.py'))


def _load():
    spec = importlib.util.spec_from_file_location('moex_source', _MOEX_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


moex = _load()

# --- fixtures ---------------------------------------------------------------

_HIST_COLS = ['BOARDID', 'TRADEDATE', 'SHORTNAME', 'SECID', 'NUMTRADES',
              'VALUE', 'OPEN', 'LOW', 'HIGH', 'LEGALCLOSEPRICE', 'WAPRICE',
              'CLOSE', 'VOLUME']


def _history_payload(rows, index=0, pagesize=100, total=None, board='TQBR',
                     sec='SBER'):
    """rows: [(date, o, h, l, c, v)] with None allowed to model gaps."""
    data = [[board, d, sec, sec, 10, 1000.0, o, l, h, c, c, c, v]
            for (d, o, h, l, c, v) in rows]
    if total is None:
        total = len(data)
    return {
        'history': {'columns': list(_HIST_COLS), 'data': data},
        'history.cursor': {'columns': ['INDEX', 'PAGESIZE', 'TOTAL'],
                           'data': [[index, pagesize, total]]},
    }


_CANDLE_COLS = ['open', 'close', 'high', 'low', 'value', 'volume',
                'begin', 'end']


def _candles_payload(rows, index=0, pagesize=500, total=None):
    """rows: [(begin, o, h, l, c, v)] with None allowed to model gaps."""
    data = [[o, c, h, l, 1000.0, v, b, b] for (b, o, h, l, c, v) in rows]
    if total is None:
        total = len(data)
    return {
        'candles': {'columns': list(_CANDLE_COLS), 'data': data},
        'candles.cursor': {'columns': ['INDEX', 'PAGESIZE', 'TOTAL'],
                           'data': [[index, pagesize, total]]},
    }


_AGG_COLS = ['SECID', 'DATE', 'OPEN', 'HIGH', 'LOW', 'CLOSE', 'VOLUME', 'VALUE']


def _aggregates_payload(rows, sec='SBER'):
    data = [[sec, d, o, h, l, c, v, 1000.0] for (d, o, h, l, c, v) in rows]
    return {'aggregates': {'columns': list(_AGG_COLS), 'data': data}}


def _orderbook_payload(rows):
    return {'orderbook': {
        'columns': ['SECID', 'BOARDID', 'BUYSELL', 'PRICE', 'QUANTITY'],
        'data': [['SBER', 'TQBR', side, p, q] for (side, p, q) in rows]}}


def _trades_payload(rows):
    return {'trades': {
        'columns': ['TRADENO', 'TRADETIME', 'BOARDID', 'SECID',
                    'PRICE', 'QUANTITY'],
        'data': [[i, t, 'TQBR', 'SBER', p, q]
                 for i, (t, p, q) in enumerate(rows)]}}


_SEARCH_FIXTURE = {'securities': {
    'columns': ['secid', 'shortname', 'secname'],
    'data': [
        ['SBER', 'Sberbank', 'SBERBANK'],
        ['SBERP', 'Sberbank-p', 'SBERBANK-P'],
        ['IMOEX', 'IMOEX', 'MOEX Russia Index'],
        ['CNY000UTSTOM', None, 'Yuan/Rouble TOM'],
    ]}}


def _scripted(pairs):
    """Fake fetcher: each call must URL-match the next (substr, payload)."""
    calls = []
    queue = list(pairs)

    def fetch(url):
        calls.append(url)
        if not queue:
            raise AssertionError('unexpected extra fetch: %r' % url)
        substr, payload = queue.pop(0)
        if substr not in url:
            raise AssertionError('%r not in %r' % (substr, url))
        if isinstance(payload, Exception):
            raise payload
        return payload

    fetch.calls = calls
    return fetch


# --- contract ----------------------------------------------------------------

class ContractTest(unittest.TestCase):
    def test_source_constants(self):
        self.assertEqual(moex.SOURCE, 'moex')
        self.assertEqual(moex.LABEL, 'Moscow Exchange (MOEX)')
        self.assertEqual(moex.INTERVALS,
                         ['1m', '10m', '1h', '1d', '1w', '1M'])
        self.assertEqual(moex.STREAM['mode'], 'poll')
        self.assertIn('MOEX/NCC/NSD US/UK SDN-listed; '
                      'read-only display, no order routing',
                      moex.STREAM['note'])

    def test_venues(self):
        venues = moex.venues()
        self.assertEqual([v['id'] for v in venues],
                         ['MOEX-SHARES', 'MOEX-INDEX', 'MOEX-FX',
                          'MOEX-OFZ', 'MOEX-FORTS'])
        for v in venues:
            self.assertTrue(v['id'])
            self.assertTrue(v['label'])


# --- interval map -------------------------------------------------------------

class IntervalTest(unittest.TestCase):
    def test_iss_codes(self):
        self.assertEqual(
            {k: moex.iss_interval(k) for k in moex.INTERVALS},
            {'1m': 1, '10m': 10, '1h': 60, '1d': 24, '1w': 7, '1M': 31})

    def test_rejection_names_supported(self):
        with self.assertRaises(Exception) as ctx:
            moex.iss_interval('5m')
        msg = str(ctx.exception)
        self.assertIn('unsupported interval', msg)
        for supported in moex.INTERVALS:
            self.assertIn(supported, msg)

    def test_candles_rejects_before_fetch(self):
        fetch = _scripted([])
        with self.assertRaises(Exception) as ctx:
            moex.candles('MOEX-SHARES', 'SBER', '5m', _fetcher=fetch)
        self.assertIn('unsupported interval', str(ctx.exception))
        self.assertEqual(len(fetch.calls), 0)


# --- routing -------------------------------------------------------------------

class ResolveTest(unittest.TestCase):
    def test_venue_defaults(self):
        cases = [
            ('MOEX-SHARES', 'SBER', ('stock', 'shares', 'TQBR', 'SBER')),
            ('MOEX-INDEX', 'IMOEX', ('stock', 'index', 'SNDX', 'IMOEX')),
            ('MOEX-FX', 'CNY000UTSTOM',
             ('currency', 'selt', 'CETS', 'CNY000UTSTOM')),
            ('MOEX-FX', 'CNYFIXME', ('currency', 'selt', 'CETS', 'CNYFIXME')),
            ('MOEX-OFZ', 'SU26238RMFS4',
             ('stock', 'bonds', 'TQOB', 'SU26238RMFS4')),
            ('MOEX-FORTS', 'Si-12.25',
             ('futures', 'forts', 'RFUD', 'Si-12.25')),
        ]
        for venue, symbol, expected in cases:
            with self.subTest(venue=venue, symbol=symbol):
                r = moex.resolve(venue, symbol)
                self.assertEqual(
                    (r['engine'], r['market'], r['board'], r['sec']),
                    expected)

    def test_board_override(self):
        r = moex.resolve('MOEX-SHARES', 'TQBR/SBER')
        self.assertEqual((r['board'], r['sec']), ('TQBR', 'SBER'))

    def test_validation_errors(self):
        with self.assertRaises(Exception):
            moex.resolve('NOPE', 'SBER')
        with self.assertRaises(Exception):
            moex.resolve('MOEX-SHARES', '   ')
        with self.assertRaises(Exception):
            moex.resolve('MOEX-SHARES', 'SB ER')
        with self.assertRaises(Exception):
            moex.resolve('MOEX-SHARES', 'TQBR/')
        with self.assertRaises(Exception):
            moex.resolve('MOEX-SHARES', 'T QB R/SBER')


# --- history / candle parsing ----------------------------------------------------

class ParseHistoryTest(unittest.TestCase):
    def test_daily_bars_and_gap_skip(self):
        payload = _history_payload([
            ('2024-01-02', 100.0, 102.0, 99.0, 101.0, 500.0),
            ('2024-01-03', None, None, None, None, None),  # holiday gap
            ('2024-01-04', 101.0, 103.0, 100.0, 102.0, None),  # vol -> 0
        ])
        bars = moex.parse_history(payload, 'SBER')
        self.assertEqual(len(bars), 2)
        self.assertEqual(bars[0]['t'], 1704153600000)  # 2024-01-02 UTC
        self.assertEqual(bars[1]['t'], 1704326400000)  # 2024-01-04 UTC
        self.assertEqual(
            (bars[0]['o'], bars[0]['h'], bars[0]['l'], bars[0]['c']),
            (100.0, 102.0, 99.0, 101.0))
        self.assertEqual(bars[0]['v'], 500.0)
        self.assertEqual(bars[1]['v'], 0)
        self.assertEqual([b['t'] for b in bars], sorted(b['t'] for b in bars))

    def test_missing_block_raises(self):
        with self.assertRaises(Exception):
            moex.parse_history({}, 'SBER')


class ParseCandlesTest(unittest.TestCase):
    def test_intraday_begin_end_value_volume(self):
        payload = _candles_payload([
            ('2024-01-02 10:00:00', 100.0, 101.0, 99.5, 100.5, 50.0),
            ('2024-01-02 10:01:00', None, None, None, None, None),
            ('2024-01-02 10:02:00', 100.5, 102.0, 100.0, 101.5, 60.0),
        ])
        bars = moex.parse_candles(payload, 'SBER')
        self.assertEqual(len(bars), 2)
        self.assertEqual(bars[0]['t'], 1704189600000)  # 10:00 UTC
        self.assertEqual(bars[1]['t'], 1704189720000)  # 10:02 UTC
        self.assertEqual(
            (bars[0]['o'], bars[0]['h'], bars[0]['l'], bars[0]['c'],
             bars[0]['v']),
            (100.0, 101.0, 99.5, 100.5, 50.0))

    def test_missing_block_raises(self):
        with self.assertRaises(Exception):
            moex.parse_candles({}, 'SBER')


# --- pagination merge -------------------------------------------------------------

class PaginationTest(unittest.TestCase):
    def test_merge_dedupe_and_sort(self):
        p1 = [{'t': 2, 'o': 1.0, 'h': 1.0, 'l': 1.0, 'c': 1.0, 'v': 1.0},
              {'t': 1, 'o': 1.0, 'h': 1.0, 'l': 1.0, 'c': 1.0, 'v': 1.0}]
        p2 = [{'t': 2, 'o': 2.0, 'h': 2.0, 'l': 2.0, 'c': 2.0, 'v': 2.0},
              {'t': 3, 'o': 3.0, 'h': 3.0, 'l': 3.0, 'c': 3.0, 'v': 3.0}]
        merged = moex.merge_bars([p1, p2])
        self.assertEqual([b['t'] for b in merged], [1, 2, 3])
        self.assertEqual(merged[1]['o'], 2.0)  # last page wins

    def test_daily_pagination_and_limit_trim(self):
        page1 = _history_payload(
            [('2024-01-02', 1.0, 1.0, 1.0, 1.0, 10.0),
             ('2024-01-03', 2.0, 2.0, 2.0, 2.0, 20.0)],
            index=0, pagesize=2, total=3)
        page2 = _history_payload(
            [('2024-01-03', 2.0, 2.0, 2.0, 2.0, 20.0),
             ('2024-01-04', 3.0, 3.0, 3.0, 3.0, 30.0)],
            index=2, pagesize=2, total=3)
        fetch = _scripted([('history', page1), ('start=2', page2)])
        bars = moex.candles('MOEX-SHARES', 'SBER', '1d',
                            limit=2, _fetcher=fetch)
        self.assertEqual([b['c'] for b in bars], [2.0, 3.0])
        self.assertEqual(len(fetch.calls), 2)
        self.assertIn('iss.only=history', fetch.calls[0])
        self.assertNotIn('start=', fetch.calls[0])
        self.assertIn('start=2', fetch.calls[1])

    def test_record_shape_and_ascending(self):
        payload = _history_payload([
            ('2024-01-02', 100.0, 102.0, 99.0, 101.0, 500.0),
            ('2024-01-03', 101.0, 103.0, 100.0, 102.0, 600.0),
        ])
        fetch = _scripted([('history', payload)])
        bars = moex.candles('MOEX-SHARES', 'SBER', '1d', _fetcher=fetch)
        self.assertEqual(len(bars), 2)
        for b in bars:
            self.assertEqual(set(b.keys()), {'t', 'o', 'h', 'l', 'c', 'v'})
            self.assertIsInstance(b['t'], int)
            for k in ('o', 'h', 'l', 'c', 'v'):
                self.assertIsInstance(b[k], float)

    def test_empty_history_raises_history_unavailable(self):
        empty = _history_payload([], total=0)
        fetch = _scripted([('history', empty),
                           ('aggregates', {'aggregates':
                                           {'columns': [], 'data': []}})])
        with self.assertRaises(Exception) as ctx:
            moex.candles('MOEX-SHARES', 'DELISTED', '1d', _fetcher=fetch)
        self.assertIn('history unavailable', str(ctx.exception))

    def test_aggregates_fallback_same_secid(self):
        empty = _history_payload([], total=0)
        agg = _aggregates_payload(
            [('2024-01-02', 100.0, 102.0, 99.0, 101.0, 500.0)])
        fetch = _scripted([('history', empty), ('aggregates', agg)])
        bars = moex.candles('MOEX-SHARES', 'SBER', '1d', _fetcher=fetch)
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0]['c'], 101.0)
        self.assertIn('/securities/SBER/aggregates.json',
                      fetch.calls[1])

    def test_invalid_limit_raises(self):
        fetch = _scripted([])
        with self.assertRaises(Exception):
            moex.candles('MOEX-SHARES', 'SBER', '1d',
                         limit='abc', _fetcher=fetch)
        self.assertEqual(len(fetch.calls), 0)


# --- venue URL shapes ---------------------------------------------------------------

class UrlShapeTest(unittest.TestCase):
    def test_history_shapes(self):
        cases = [
            ('MOEX-SHARES', 'SBER',
             'history/engines/stock/markets/shares/boards/TQBR/securities/SBER.json'),
            ('MOEX-INDEX', 'IMOEX',
             'history/engines/stock/markets/index/boards/SNDX/securities/IMOEX.json'),
            ('MOEX-FX', 'CNY000UTSTOM',
             'history/engines/currency/markets/selt/boards/CETS/securities/CNY000UTSTOM.json'),
            ('MOEX-OFZ', 'SU26238RMFS4',
             'history/engines/stock/markets/bonds/boards/TQOB/securities/SU26238RMFS4.json'),
            ('MOEX-FORTS', 'Si-12.25',
             'history/engines/futures/markets/forts/boards/RFUD/securities/Si-12.25.json'),
        ]
        for venue, symbol, shape in cases:
            with self.subTest(venue=venue):
                r = moex.resolve(venue, symbol)
                url = moex.history_url(r['engine'], r['market'],
                                       r['board'], r['sec'],
                                       from_='2024-01-01', till='2024-06-01')
                self.assertIn(shape, url)
                self.assertIn('from=2024-01-01', url)
                self.assertIn('till=2024-06-01', url)

    def test_candles_interval_param(self):
        r = moex.resolve('MOEX-SHARES', 'SBER')
        url = moex.candles_url(r['engine'], r['market'], r['board'],
                               r['sec'], '1m',
                               '2024-01-02 10:00:00', '2024-01-03 10:00:00')
        self.assertIn('/candles.json?', url)
        self.assertIn('interval=1', url)
        self.assertIn('from=2024-01-02', url)
        weekly = moex.candles_url(r['engine'], r['market'], r['board'],
                                  r['sec'], '1w',
                                  '2024-01-01 00%3A00%3A00',
                                  '2024-06-01 00%3A00%3A00')
        self.assertIn('interval=7', weekly)

    def test_fx_and_fixing_shapes(self):
        for sec in ('CNY000UTSTOM', 'CNYFIXME'):
            r = moex.resolve('MOEX-FX', sec)
            url = moex.candles_url(
                r['engine'], r['market'], r['board'], r['sec'], '1h',
                '2024-01-02 00:00:00', '2024-01-03 00:00:00')
            self.assertIn('engines/currency/markets/selt/boards/CETS', url)
            self.assertIn('securities/%s/candles.json' % sec, url)
            self.assertIn('interval=60', url)

    def test_orderbook_trades_shapes(self):
        r = moex.resolve('MOEX-SHARES', 'SBER')
        ob = moex.orderbook_url(r['engine'], r['market'],
                                r['board'], r['sec'])
        self.assertIn('securities/SBER/orderbook.json', ob)
        tape = moex.trades_url(r['engine'], r['market'],
                               r['board'], r['sec'])
        self.assertIn('securities/SBER/trades.json', tape)

    def test_aggregates_shape(self):
        self.assertIn('/securities/SBER/aggregates.json',
                      moex.aggregates_url('SBER'))

    def test_search_shape(self):
        self.assertIn('/securities.json?', moex.search_url('sber'))
        self.assertIn('q=sber', moex.search_url('sber'))


# --- orderbook -----------------------------------------------------------------

class OrderbookTest(unittest.TestCase):
    def test_bids_asks_sorted_and_trimmed(self):
        payload = _orderbook_payload([
            ('S', 102.0, 5.0), ('B', 100.0, 10.0), ('B', 101.0, 7.0),
            ('S', 101.5, 3.0), ('X', 999.0, 1.0), ('B', None, 4.0),
        ])
        book = moex.parse_orderbook(payload, 'SBER')
        self.assertEqual(book['bids'], [[101.0, 7.0], [100.0, 10.0]])
        self.assertEqual(book['asks'], [[101.5, 3.0], [102.0, 5.0]])

    def test_denied_shapes_raise_degraded(self):
        for payload in ({}, {'orderbook': {'columns': [], 'data': []}},
                        {'message': 'denied'}):
            with self.subTest(payload=payload):
                with self.assertRaises(Exception) as ctx:
                    moex.parse_orderbook(payload, 'SBER')
                msg = str(ctx.exception)
                self.assertIn('unavailable', msg)
                self.assertIn('subscribers-only', msg)

    def test_depth_contract_and_limit(self):
        payload = _orderbook_payload([
            ('B', 100.0, 10.0), ('B', 99.0, 9.0), ('S', 101.0, 8.0),
        ])
        fetch = _scripted([('orderbook', payload)])
        book = moex.depth('MOEX-SHARES', 'SBER', limit=1, _fetcher=fetch)
        self.assertEqual(book['symbol'], 'SBER')
        self.assertEqual(book['venue'], 'MOEX-SHARES')
        self.assertEqual(book['bids'], [[100.0, 10.0]])
        self.assertEqual(book['asks'], [[101.0, 8.0]])

    def test_depth_denied_never_fakes(self):
        fetch = _scripted([('orderbook', {})])
        with self.assertRaises(Exception) as ctx:
            moex.depth('MOEX-SHARES', 'SBER', _fetcher=fetch)
        self.assertIn('subscribers-only', str(ctx.exception))

    def test_depth_transport_denied_maps_to_degraded(self):
        # Upstream answers denied shapes with non-JSON (HTML) bodies.
        fetch = _scripted(
            [('orderbook', Exception('parse error: invalid JSON (denied)'))])
        with self.assertRaises(Exception) as ctx:
            moex.depth('MOEX-SHARES', 'SBER', _fetcher=fetch)
        msg = str(ctx.exception)
        self.assertIn('subscribers-only', msg)
        self.assertIn('no fallback', msg)


# --- FX / fixing parse ------------------------------------------------------------

class FxParseTest(unittest.TestCase):
    def test_fx_candles_parse(self):
        payload = _candles_payload([
            ('2024-01-02 07:00:00', 12.60, 12.65, 12.58, 12.62, 100000.0),
            ('2024-01-02 08:00:00', 12.62, 12.70, 12.60, 12.68, 120000.0),
        ])
        bars = moex.parse_candles(payload, 'CNY000UTSTOM')
        self.assertEqual(len(bars), 2)
        self.assertEqual((bars[0]['o'], bars[0]['c'], bars[0]['v']),
                         (12.60, 12.62, 100000.0))
        self.assertLess(bars[0]['t'], bars[1]['t'])

    def test_fixing_daily_parse(self):
        payload = _history_payload(
            [('2024-01-02', 12.60, 12.65, 12.58, 12.62, 100000.0)],
            board='CETS', sec='CNYFIXME')
        bars = moex.parse_history(payload, 'CNYFIXME')
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0]['c'], 12.62)


# --- search / quote / trades ----------------------------------------------------------

class SearchTest(unittest.TestCase):
    def test_symbol_name_mapping(self):
        fetch = _scripted([('securities.json', _SEARCH_FIXTURE)])
        rows = moex.search('MOEX-SHARES', 'sber', _fetcher=fetch)
        self.assertEqual(rows[0], {'symbol': 'SBER', 'name': 'Sberbank'})
        self.assertEqual(rows[2]['symbol'], 'IMOEX')
        # None shortname falls back to secname.
        self.assertEqual(rows[3],
                         {'symbol': 'CNY000UTSTOM', 'name': 'Yuan/Rouble TOM'})
        for r in rows:
            self.assertEqual(set(r.keys()), {'symbol', 'name'})

    def test_validation_errors(self):
        fetch = _scripted([])
        with self.assertRaises(Exception):
            moex.search('MOEX-SHARES', '   ', _fetcher=fetch)
        with self.assertRaises(Exception):
            moex.search('MOEX-SHARES', 'x' * 65, _fetcher=fetch)
        with self.assertRaises(Exception):
            moex.search('NOPE', 'sber', _fetcher=fetch)
        self.assertEqual(len(fetch.calls), 0)


class QuoteTest(unittest.TestCase):
    def test_change_math(self):
        payload = _history_payload([
            ('2024-01-02', 100.0, 101.0, 99.0, 100.0, 500.0),
            ('2024-01-03', 100.0, 103.0, 99.0, 102.0, 600.0),
            ('2024-01-04', 102.0, 104.0, 101.0, 103.0, 700.0),
        ])
        fetch = _scripted([('history', payload)])
        q = moex.quote('MOEX-SHARES', 'SBER', _fetcher=fetch)
        self.assertEqual(q['price'], 103.0)
        self.assertEqual(q['prev_close'], 102.0)
        self.assertAlmostEqual(q['change_pct'], (103.0 - 102.0) / 102.0 * 100)
        self.assertEqual(q['t'], 1704326400000)

    def test_needs_two_bars(self):
        payload = _history_payload(
            [('2024-01-02', 1.0, 1.0, 1.0, 1.0, 5.0)])
        fetch = _scripted([('history', payload)])
        with self.assertRaises(Exception):
            moex.quote('MOEX-SHARES', 'SBER', _fetcher=fetch)


class TradesTest(unittest.TestCase):
    def test_tape_parse(self):
        payload = _trades_payload([
            ('2024-01-02 10:00:01', 100.5, 10.0),
            ('2024-01-02 10:00:03', 100.6, 5.0),
        ])
        rows = moex.parse_trades(payload, 'SBER')
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['price'], 100.5)
        self.assertEqual(rows[0]['qty'], 10.0)
        self.assertLess(rows[0]['t'], rows[1]['t'])

    def test_missing_block_raises(self):
        with self.assertRaises(Exception):
            moex.parse_trades({}, 'SBER')


# --- transport ---------------------------------------------------------------------

class TransportTest(unittest.TestCase):
    def test_pacing_budget(self):
        self.assertGreaterEqual(moex._MIN_GAP, 0.2)  # <=5 req/s

    def test_pace_sleeps_on_hot_path(self):
        with mock.patch.object(moex.time, 'monotonic', return_value=100.0):
            moex._LAST_TS[0] = 100.0
            with mock.patch.object(moex.time, 'sleep') as slept:
                moex._pace()
        slept.assert_called_once()
        self.assertAlmostEqual(slept.call_args[0][0], moex._MIN_GAP)

    def test_browser_like_ua(self):
        self.assertIn('Mozilla/5.0', moex._UA)


if __name__ == '__main__':
    unittest.main()

# --- LIVE NOTES (informational only; never gate tests) ---------------------------
# Verified live 2026-10-14 per mandate: ISS is keyless and open
# (https://iss.moex.com/iss/...). Spot-checks, when network allows:
#   curl 'https://iss.moex.com/iss/history/engines/stock/markets/shares/boards/TQBR/securities/SBER.json?iss.meta=off&iss.only=history,history.cursor'
#   curl 'https://iss.moex.com/iss/engines/currency/markets/selt/boards/CETS/securities/CNY000UTSTOM/candles.json?iss.meta=off&from=2024-01-02%2000:00:00&till=2024-01-03%2000:00:00&interval=60'
# Orderbook is officially subscribers-only: expect empty/denied answers.

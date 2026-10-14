"""Stub fixture source for companion core tests (workstream B).

Zero optional dependencies. Serves deterministic static data so the
companion HTTP surface, validation, and cache layers are testable fully
offline. Not a market: LABEL says fixture, STREAM.mode is 'snapshot'.

Implements the canonical source-module contract verbatim:
  SOURCE, LABEL, INTERVALS, STREAM, venues(), candles(), search(),
  plus optional quote() / depth().

Test hook: symbol 'STUB/FAIL' raises on candles/quote/depth to exercise
the server's 502 + negative-error-cache path without any network.
"""

import time

SOURCE = "stub"
LABEL = "Stub (offline fixture)"
INTERVALS = ["1m", "5m", "1h", "1d", "1wk"]
STREAM = {"mode": "snapshot", "cadence": 60, "note": "static fixture; offline-safe"}

_VENUES = [{"id": "STUB", "label": "Stub Venue"}]

_FIXTURES = [
    {"symbol": "STUB:FOO", "name": "Foo Fixture"},
    {"symbol": "STUB:BAR", "name": "Bar Fixture"},
    {"symbol": "STUB/Baz", "name": "Baz Fixture"},
]

_BASE_T = 1704067200000  # 2024-01-01T00:00:00Z, fixed so fixtures are stable
_FAIL_SYMBOL = "STUB/FAIL"


def venues():
    """Return venue descriptors."""
    return [dict(v) for v in _VENUES]


def _base(symbol):
    return 100.0 + (sum(ord(c) for c in symbol) % 50)


def candles(venue, symbol, interval, limit=300):
    """Return ascending static bars; raise on failure (never substitute)."""
    if interval not in INTERVALS:
        raise Exception("unsupported interval %r; stub supports %s" % (interval, INTERVALS))
    if symbol == _FAIL_SYMBOL:
        raise Exception("stub upstream failure (fixture)")
    n = max(1, min(int(limit), 1000))
    base = _base(symbol)
    out = []
    for i in range(n):
        o = base + i * 0.5
        out.append(
            {
                "t": _BASE_T + i * 86400000,
                "o": o,
                "h": o + 1.0,
                "l": o - 1.0,
                "c": o + 0.25,
                "v": 1000.0 + i * 10.0,
            }
        )
    return out


def search(venue, query):
    """Case-insensitive substring filter over the static fixture list."""
    q = (query or "").strip().lower()
    if not q:
        return [dict(f) for f in _FIXTURES]
    return [dict(f) for f in _FIXTURES if q in f["symbol"].lower() or q in f["name"].lower()]


def quote(venue, symbol):
    """Return a static quote tick."""
    if symbol == _FAIL_SYMBOL:
        raise Exception("stub upstream failure (fixture)")
    return {"symbol": symbol, "venue": venue, "price": _base(symbol), "t": int(time.time() * 1000)}


def depth(venue, symbol, limit=20):
    """Return a static few-level order book."""
    if symbol == _FAIL_SYMBOL:
        raise Exception("stub upstream failure (fixture)")
    n = max(1, min(int(limit), 25))
    base = _base(symbol)
    return {
        "symbol": symbol,
        "venue": venue,
        "bids": [[round(base - 0.5 - i * 0.5, 2), 1.0 + i] for i in range(n)],
        "asks": [[round(base + 0.5 + i * 0.5, 2), 1.0 + i] for i in range(n)],
    }

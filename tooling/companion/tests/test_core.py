"""Companion core contract tests (workstream B).

Stdlib unittest only. Spins up a live server instance on an ephemeral
127.0.0.1 port and exercises the contract routes against the zero-dep
stub source, so the suite passes fully offline:

  python3 -m unittest discover -s tooling/companion/tests
"""

import atexit
import importlib.util
import json
import os
import shutil
import tempfile
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

COMPANION_DIR = Path(__file__).resolve().parents[1]

# Keep runtime disk-cache writes out of the repo during tests.
_TEST_CACHE_DIR = tempfile.mkdtemp(prefix="opentape-test-cache-")
os.environ.setdefault("OPENTAPE_CACHE_DIR", _TEST_CACHE_DIR)
atexit.register(lambda: shutil.rmtree(_TEST_CACHE_DIR, ignore_errors=True))


def _load_server():
    spec = importlib.util.spec_from_file_location(
        "opentape_companion_server_under_test", COMPANION_DIR / "server.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


server = _load_server()


def _req(port, path, method="GET"):
    url = "http://127.0.0.1:%d%s" % (port, path)
    req = Request(url, method=method)
    try:
        with urlopen(req, timeout=10) as resp:
            raw = resp.read().decode().strip()
            return resp.status, dict(resp.headers), json.loads(raw) if raw else {}
    except HTTPError as exc:
        try:
            body = json.loads(exc.read().decode() or "{}")
        except ValueError:
            body = {}
        return exc.code, dict(exc.headers), body


def _q(path, **params):
    return path + "?" + urlencode(params)


class CoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = __import__("threading").Thread(
            target=cls.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        cls.thread.start()
        deadline = time.time() + 10.0
        while time.time() < deadline:
            try:
                status, _, _ = _req(cls.port, "/health")
                if status == 200:
                    return
            except OSError:
                pass
            time.sleep(0.05)
        raise RuntimeError("test server did not become ready")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.thread.join(timeout=10)
        cls.httpd.server_close()

    # -- helpers ----------------------------------------------------

    def assertErrorShape(self, body, source_expected="__any__"):
        self.assertIsInstance(body, dict)
        for key in ("error", "reason", "source"):
            self.assertIn(key, body, "error body missing %r: %r" % (key, body))
        self.assertIsInstance(body["error"], str)
        self.assertIsInstance(body["reason"], str)
        if source_expected != "__any__":
            self.assertEqual(body["source"], source_expected)

    # -- tests ------------------------------------------------------

    def test_health_shape(self):
        status, headers, body = _req(self.port, "/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        self.assertIs(body["ok"], True)
        self.assertIsInstance(body["time"], int)
        self.assertIsInstance(body["sources"], dict)
        self.assertIn("stub", body["sources"])
        self.assertEqual(body["sources"]["stub"], {"ok": True})

    def test_sources_list_includes_stub(self):
        status, _, body = _req(self.port, "/api/sources")
        self.assertEqual(status, 200)
        self.assertIsInstance(body, list)
        stub = next((s for s in body if s.get("id") == "stub"), None)
        self.assertIsNotNone(stub, "stub missing from %r" % (body,))
        for key in ("id", "label", "intervals", "stream", "venues"):
            self.assertIn(key, stub)
        self.assertIn("1d", stub["intervals"])
        self.assertIsInstance(stub["venues"], list)
        self.assertGreaterEqual(len(stub["venues"]), 1)
        self.assertIn("id", stub["venues"][0])

    def test_candles_echo_via_stub(self):
        status, _, body = _req(
            self.port, _q("/api/candles", source="stub", venue="STUB",
                          symbol="FOO", interval="1d", limit="5"))
        self.assertEqual(status, 200)
        self.assertIn("candles", body)
        self.assertIn("meta", body)
        self.assertEqual(len(body["candles"]), 5)
        first = body["candles"][0]
        for key in ("t", "o", "h", "l", "c", "v"):
            self.assertIn(key, first)
        ts = [b["t"] for b in body["candles"]]
        self.assertEqual(ts, sorted(ts), "candles must ascend")
        meta = body["meta"]
        for key in ("source", "venue", "cached_at", "ttl", "stale", "fallback"):
            self.assertIn(key, meta, "meta missing %r" % key)
        self.assertEqual(meta["source"], "stub")
        self.assertEqual(meta["venue"], "STUB")
        self.assertIs(meta["stale"], False)
        self.assertEqual(meta["fallback"], [])

    def test_bad_symbol_400(self):
        status, _, body = _req(
            self.port, _q("/api/candles", source="stub", venue="STUB",
                          symbol="BAD SYMBOL!", interval="1d"))
        self.assertEqual(status, 400)
        self.assertErrorShape(body, "stub")
        self.assertEqual(body["error"], "invalid_symbol")

    def test_bad_interval_400_lists_supported(self):
        status, _, body = _req(
            self.port, _q("/api/candles", source="stub", venue="STUB",
                          symbol="FOO", interval="9y"))
        self.assertEqual(status, 400)
        self.assertErrorShape(body, "stub")
        self.assertEqual(body["error"], "unsupported_interval")
        self.assertIn("supported", body)
        self.assertIn("1d", body["supported"])

    def test_bad_limit_400(self):
        status, _, body = _req(
            self.port, _q("/api/candles", source="stub", venue="STUB",
                          symbol="FOO", interval="1d", limit="abc"))
        self.assertEqual(status, 400)
        self.assertErrorShape(body, "stub")

    def test_limit_clamp(self):
        status, _, body = _req(
            self.port, _q("/api/candles", source="stub", venue="STUB",
                          symbol="FOO", interval="1d", limit="0"))
        self.assertEqual(status, 200)
        self.assertEqual(len(body["candles"]), 1)

    def test_unknown_source_404(self):
        status, _, body = _req(
            self.port, _q("/api/candles", source="nope", venue="X",
                          symbol="FOO", interval="1d"))
        self.assertEqual(status, 404)
        self.assertErrorShape(body, "nope")

    def test_unknown_route_404(self):
        status, _, body = _req(self.port, "/nope")
        self.assertEqual(status, 404)
        self.assertErrorShape(body, None)

    def test_cache_hit_returns_identical_cached_at(self):
        path = _q("/api/candles", source="stub", venue="STUB",
                  symbol="CACHEPROBE", interval="1d", limit="3")
        _, _, first = _req(self.port, path)
        _, _, second = _req(self.port, path)
        self.assertEqual(first["meta"]["cached_at"], second["meta"]["cached_at"])
        self.assertEqual(first["candles"], second["candles"])

    def test_upstream_502_and_negative_cache(self):
        path = _q("/api/candles", source="stub", venue="STUB",
                  symbol="STUB/FAIL", interval="1d", limit="3")
        status1, _, body1 = _req(self.port, path)
        self.assertEqual(status1, 502)
        self.assertErrorShape(body1, "stub")
        status2, _, body2 = _req(self.port, path)
        self.assertEqual(status2, 502)
        self.assertEqual(body1["reason"], body2["reason"])

    def test_search_quote_depth_routes(self):
        status, _, body = _req(
            self.port, _q("/api/search", source="stub", venue="STUB", q="foo"))
        self.assertEqual(status, 200)
        self.assertIn("results", body)
        self.assertTrue(any(r.get("symbol") == "STUB:FOO" for r in body["results"]))

        status, _, body = _req(
            self.port, _q("/api/quote", source="stub", venue="STUB", symbol="FOO"))
        self.assertEqual(status, 200)
        self.assertIn("quote", body)
        self.assertEqual(body["quote"]["symbol"], "FOO")

        status, _, body = _req(
            self.port, _q("/api/depth", source="stub", venue="STUB",
                          symbol="FOO", limit="2"))
        self.assertEqual(status, 200)
        self.assertIn("depth", body)
        self.assertEqual(len(body["depth"]["bids"]), 2)
        self.assertEqual(len(body["depth"]["asks"]), 2)

    def test_options_preflight(self):
        status, headers, _ = _req(self.port, "/health", method="OPTIONS")
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")


if __name__ == "__main__":
    unittest.main()

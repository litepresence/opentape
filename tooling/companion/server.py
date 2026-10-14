"""Opentape companion API — workstream B (stdlib only).

Localhost-only HTTP suite serving keyless markets to the static terminal.
Implements the Companion HTTP surface + source-module contracts verbatim
from docs/superpowers/plans/2026-10-14-opentape-suite.md:

  GET /health      -> {ok, sources: {id: {ok, reason?}}, time}
  GET /api/sources -> [{id, label, intervals, stream, venues: [...]}]
  GET /api/candles?source=&venue=&symbol=&interval=&limit=
    -> {candles: [...], meta: {source, venue, cached_at, ttl, stale, fallback: []}}
  GET /api/search?source=&venue=&q=
  GET /api/quote?source=&venue=&symbol=
  GET /api/depth?source=&venue=&symbol=&limit=

Global constraints: binds 127.0.0.1 only (never 0.0.0.0); no secrets;
keyless sources only; live-only honesty (errors carry reasons, stale wears
a badge, never substitutes data).

Run:
  python3 tooling/companion/server.py [--port 8788] [port]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
DEFAULT_PORT = 8788
DEFAULT_TTL = 60.0  # seconds, when a source advertises no usable cadence
ERROR_TTL = 10.0  # negative-cache window for upstream errors
LIMIT_MIN, LIMIT_MAX = 1, 1000
DEFAULT_CANDLE_LIMIT = 300
DEFAULT_DEPTH_LIMIT = 20

# Verbatim validation: symbol ^[A-Za-z0-9.\-=^:/]{1,64}$ (per-source tighten allowed).
SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-=^:/]{1,64}$")

BASE_DIR = Path(__file__).resolve().parent
SOURCES_DIR = BASE_DIR / "sources"
DISK_DIR = Path(os.environ.get("OPENTAPE_CACHE_DIR", BASE_DIR / ".cache"))

REQUIRED_ATTRS = ("SOURCE", "LABEL", "INTERVALS", "STREAM", "venues", "candles", "search")


# ---------------------------------------------------------------- registry ---


def _load_source_module(path: Path) -> dict:
    """Import one sources/*.py file defensively; never raise."""
    stem = path.stem
    try:
        spec = importlib.util.spec_from_file_location(
            "opentape_companion_source_%s" % stem, path
        )
        if spec is None or spec.loader is None:
            raise ImportError("cannot build import spec for %s" % path.name)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    except Exception as exc:
        return {"id": stem, "module": None, "ok": False,
                "reason": "import failed: %s" % exc}
    missing = [a for a in REQUIRED_ATTRS if not hasattr(mod, a)]
    if missing:
        return {"id": str(getattr(mod, "SOURCE", stem)), "module": None,
                "ok": False, "reason": "missing attributes: %s" % ", ".join(missing)}
    for fn in ("venues", "candles", "search"):
        if not callable(getattr(mod, fn)):
            return {"id": str(mod.SOURCE), "module": None,
                    "ok": False, "reason": "%s is not callable" % fn}
    try:
        label = str(mod.LABEL)
        intervals = list(mod.INTERVALS)
        stream = dict(mod.STREAM)
    except Exception as exc:
        return {"id": str(mod.SOURCE), "module": None,
                "ok": False, "reason": "bad contract constants: %s" % exc}
    return {"id": str(mod.SOURCE), "module": mod, "label": label,
            "intervals": intervals, "stream": stream, "ok": True, "reason": None}


def load_registry() -> dict:
    """(Re)build the source registry; one bad file never stops the server."""
    reg: dict = {}
    if SOURCES_DIR.is_dir():
        for path in sorted(SOURCES_DIR.glob("*.py")):
            if path.name == "__init__.py":
                continue
            entry = _load_source_module(path)
            if entry["id"] in reg:
                entry = {"id": entry["id"], "module": None, "ok": False,
                         "reason": "duplicate SOURCE id %r" % entry["id"]}
            reg[entry["id"]] = entry
    return reg


REGISTRY: dict = load_registry()


def lookup(source_id: str | None) -> dict | None:
    return REGISTRY.get(source_id) if source_id else None


def ttl_for(entry: dict) -> float:
    """Per-source TTL: the source's STREAM cadence, else DEFAULT_TTL."""
    try:
        cad = entry.get("stream", {}).get("cadence")
        if isinstance(cad, bool):
            raise ValueError
        cad = float(cad)
        if cad > 0:
            return min(max(cad, 5.0), 3600.0)
    except (TypeError, ValueError, AttributeError):
        pass
    return DEFAULT_TTL


# ------------------------------------------------------------- cache ------


_CACHE: dict[str, tuple[float, dict]] = {}  # key -> (expires_at, body)
_NEG: dict[str, tuple[float, int, dict]] = {}  # key -> (expires_at, status, body)
_LOCKS: dict[str, threading.Lock] = {}
_GUARD = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _LOCKS[key] = lock
        return lock


def _disk_name(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", key)[:180] + ".json"


def _disk_read(key: str) -> dict | None:
    """On-disk cache is OHLCV-only; returns the stored success body or None."""
    try:
        raw = (DISK_DIR / _disk_name(key)).read_text(encoding="utf-8")
        body = json.loads(raw)
        if isinstance(body, dict) and isinstance(body.get("candles"), list):
            return body
    except (OSError, ValueError, UnicodeError):
        pass
    return None


def _disk_write(key: str, body: dict) -> None:
    try:
        DISK_DIR.mkdir(parents=True, exist_ok=True)
        (DISK_DIR / _disk_name(key)).write_text(json.dumps(body), encoding="utf-8")
    except OSError:
        pass


# ---------------------------------------------------------------- errors ---


class HttpError(Exception):
    def __init__(self, status: int, error: str, reason: str,
                 source: str | None = None, extra: dict | None = None):
        super().__init__(reason)
        self.status = status
        self.body = {"error": error, "reason": reason, "source": source}
        if extra:
            self.body.update(extra)


class NegHit(Exception):
    """Raised when a key sits in the negative error cache."""

    def __init__(self, status: int, body: dict):
        super().__init__("negative-cached error")
        self.status = status
        self.body = body


def _unsupported_interval(interval: str, entry: dict) -> HttpError:
    return HttpError(
        400, "unsupported_interval",
        "interval %r not supported by source %r" % (interval, entry["id"]),
        entry["id"], {"supported": entry["intervals"]},
    )


def _check_symbol(symbol: str | None, source: str | None) -> str:
    if not symbol:
        raise HttpError(400, "missing_symbol",
                        "query param 'symbol' is required", source)
    if not SYMBOL_RE.match(symbol):
        raise HttpError(400, "invalid_symbol",
                        "symbol %r must match ^[A-Za-z0-9.\\-=^:/]{1,64}$" % symbol,
                        source)
    return symbol


def _parse_limit(raw: str | None, default: int, source: str | None) -> int:
    if raw is None or raw == "":
        return default
    try:
        n = int(raw)
    except (TypeError, ValueError):
        raise HttpError(400, "invalid_limit",
                        "limit %r is not an integer" % raw, source)
    return max(LIMIT_MIN, min(LIMIT_MAX, n))


def _require_source(source_id: str | None) -> dict:
    if not source_id:
        raise HttpError(400, "missing_source",
                        "query param 'source' is required", None)
    entry = lookup(source_id)
    if entry is None:
        raise HttpError(404, "unknown_source",
                        "unknown source %r" % source_id, source_id,
                        {"supported": sorted(REGISTRY.keys())})
    if not entry["ok"]:
        raise HttpError(404, "source_unavailable",
                        "source %r unavailable: %s" % (source_id, entry.get("reason")),
                        source_id)
    return entry


# ---------------------------------------------------------------- handler --


class Handler(BaseHTTPRequestHandler):
    server_version = "OpentapeCompanion/1"

    def log_message(self, *args):  # replaced by structured one-line logs
        pass

    # -- plumbing ---------------------------------------------------

    def _send_json(self, status: int, obj: dict) -> None:
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _log(self, route: str, status: int, ms: float, source: str | None) -> None:
        print(json.dumps({"ts": int(time.time()), "method": self.command,
                          "route": route, "status": status,
                          "ms": round(ms, 1), "source": source}),
              file=sys.stderr, flush=True)

    def _qp(self, qs: dict, name: str, default: str | None = None) -> str | None:
        vals = qs.get(name)
        return vals[0] if vals else default

    def do_OPTIONS(self) -> None:
        t0 = time.monotonic()
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
        self._log(urlparse(self.path).path, 204,
                  (time.monotonic() - t0) * 1000.0, None)

    def do_GET(self) -> None:
        t0 = time.monotonic()
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query, keep_blank_values=True)
        source_hint = (qs.get("source") or [None])[0]
        try:
            if route == "/health":
                self._send_json(200, self._health())
                status, src = 200, None
            elif route == "/api/sources":
                self._send_json(200, self._sources())
                status, src = 200, None
            elif route == "/api/candles":
                self._send_json(200, self._candles(qs))
                status, src = 200, source_hint
            elif route == "/api/search":
                self._send_json(200, self._search(qs))
                status, src = 200, source_hint
            elif route == "/api/quote":
                self._send_json(200, self._quote(qs))
                status, src = 200, source_hint
            elif route == "/api/depth":
                self._send_json(200, self._depth(qs))
                status, src = 200, source_hint
            else:
                raise HttpError(404, "not_found",
                                "unknown route %r" % parsed.path, None)
        except HttpError as exc:
            self._send_json(exc.status, exc.body)
            status, src = exc.status, exc.body.get("source", source_hint)
        except NegHit as exc:
            self._send_json(exc.status, exc.body)
            status, src = exc.status, exc.body.get("source", source_hint)
        except Exception as exc:  # honest 502, never substitute data
            traceback.print_exc(file=sys.stderr)
            self._send_json(502, {"error": "upstream", "reason": str(exc)[:500],
                                  "source": source_hint})
            status, src = 502, source_hint
        self._log(route, status, (time.monotonic() - t0) * 1000.0, src)

    # -- routes -----------------------------------------------------

    @staticmethod
    def _health() -> dict:
        sources = {}
        for sid, entry in REGISTRY.items():
            cell: dict = {"ok": bool(entry["ok"])}
            if not entry["ok"] and entry.get("reason"):
                cell["reason"] = entry["reason"]
            sources[sid] = cell
        any_ok = any(e["ok"] for e in REGISTRY.values())
        return {"ok": bool(REGISTRY) and bool(any_ok),
                "sources": sources, "time": int(time.time())}

    def _sources(self) -> list:
        out = []
        for sid, entry in REGISTRY.items():
            if not entry["ok"]:
                continue
            try:
                venues = entry["module"].venues()
                if not isinstance(venues, list):
                    raise ValueError("venues() must return a list")
            except Exception as exc:  # degraded venue list, server keeps running
                print(json.dumps({"ts": int(time.time()), "venues_error": str(exc)[:200],
                                  "source": sid}), file=sys.stderr, flush=True)
                venues = []
            out.append({"id": sid, "label": entry["label"],
                        "intervals": entry["intervals"], "stream": entry["stream"],
                        "venues": venues})
        return out

    def _candles(self, qs: dict) -> dict:
        entry = _require_source(self._qp(qs, "source"))
        sid = entry["id"]
        venue = self._qp(qs, "venue") or ""
        symbol = _check_symbol(self._qp(qs, "symbol"), sid)
        interval = self._qp(qs, "interval")
        if not interval:
            raise HttpError(400, "missing_interval",
                            "query param 'interval' is required", sid,
                            {"supported": entry["intervals"]})
        if interval not in entry["intervals"]:
            raise _unsupported_interval(interval, entry)
        limit = _parse_limit(self._qp(qs, "limit"), DEFAULT_CANDLE_LIMIT, sid)

        ttl = ttl_for(entry)
        key = "candles:%s:%s:%s:%s:%d" % (sid, venue, symbol, interval, limit)
        now_ms = int(time.time() * 1000)
        lock = _lock_for(key)
        with lock:  # single-flight per key
            hit = _CACHE.get(key)
            if hit and hit[0] > time.time():
                return hit[1]
            neg = _NEG.get(key)
            if neg and neg[0] > time.time():
                raise NegHit(neg[1], neg[2])
            try:
                candles = entry["module"].candles(venue, symbol, interval, limit)
                if not isinstance(candles, list):
                    raise ValueError("candles() must return a list")
            except Exception as exc:
                reason = str(exc)[:500] or "upstream failure"
                stale = _disk_read(key)  # stale wears a badge, never substitutes
                if stale is not None:
                    body = dict(stale)
                    meta = dict(body.get("meta", {}))
                    meta.update({"source": sid, "venue": venue, "cached_at": stale["meta"]["cached_at"] if isinstance(stale.get("meta"), dict) and "cached_at" in stale["meta"] else now_ms,
                                 "ttl": int(ttl), "stale": True, "fallback": ["disk"]})
                    body["meta"] = meta
                    _NEG.pop(key, None)
                    return body
                err_body = {"error": "upstream", "reason": reason, "source": sid}
                _NEG[key] = (time.time() + ERROR_TTL, 502, err_body)
                raise NegHit(502, err_body)
            body = {"candles": candles,
                    "meta": {"source": sid, "venue": venue, "symbol": symbol,
                             "interval": interval, "limit": limit,
                             "cached_at": now_ms, "ttl": int(ttl),
                             "stale": False, "fallback": []}}
            _CACHE[key] = (time.time() + ttl, body)
            _NEG.pop(key, None)
            _disk_write(key, body)
            return body

    def _search(self, qs: dict) -> dict:
        entry = _require_source(self._qp(qs, "source"))
        sid = entry["id"]
        venue = self._qp(qs, "venue") or ""
        q = self._qp(qs, "q")
        if q is None or q.strip() == "":
            raise HttpError(400, "missing_query",
                            "query param 'q' is required", sid)
        ttl = ttl_for(entry)
        key = "search:%s:%s:%s" % (sid, venue, q)
        now_ms = int(time.time() * 1000)
        lock = _lock_for(key)
        with lock:
            hit = _CACHE.get(key)
            if hit and hit[0] > time.time():
                return hit[1]
            neg = _NEG.get(key)
            if neg and neg[0] > time.time():
                raise NegHit(neg[1], neg[2])
            try:
                results = entry["module"].search(venue, q)
                if not isinstance(results, list):
                    raise ValueError("search() must return a list")
            except Exception as exc:
                err_body = {"error": "upstream",
                            "reason": (str(exc)[:500] or "upstream failure"),
                            "source": sid}
                _NEG[key] = (time.time() + ERROR_TTL, 502, err_body)
                raise NegHit(502, err_body)
            body = {"results": results,
                    "meta": {"source": sid, "venue": venue, "q": q,
                             "cached_at": now_ms, "ttl": int(ttl)}}
            _CACHE[key] = (time.time() + ttl, body)
            _NEG.pop(key, None)
            return body

    def _quote(self, qs: dict) -> dict:
        entry = _require_source(self._qp(qs, "source"))
        sid = entry["id"]
        if not callable(getattr(entry["module"], "quote", None)):
            raise HttpError(404, "not_supported",
                            "source %r does not implement quote" % sid, sid)
        venue = self._qp(qs, "venue") or ""
        symbol = _check_symbol(self._qp(qs, "symbol"), sid)
        ttl = ttl_for(entry)
        key = "quote:%s:%s:%s" % (sid, venue, symbol)
        now_ms = int(time.time() * 1000)
        lock = _lock_for(key)
        with lock:
            hit = _CACHE.get(key)
            if hit and hit[0] > time.time():
                return hit[1]
            neg = _NEG.get(key)
            if neg and neg[0] > time.time():
                raise NegHit(neg[1], neg[2])
            try:
                quote = entry["module"].quote(venue, symbol)
            except Exception as exc:
                err_body = {"error": "upstream",
                            "reason": (str(exc)[:500] or "upstream failure"),
                            "source": sid}
                _NEG[key] = (time.time() + ERROR_TTL, 502, err_body)
                raise NegHit(502, err_body)
            body = {"quote": quote,
                    "meta": {"source": sid, "venue": venue, "symbol": symbol,
                             "cached_at": now_ms, "ttl": int(ttl)}}
            _CACHE[key] = (time.time() + ttl, body)
            _NEG.pop(key, None)
            return body

    def _depth(self, qs: dict) -> dict:
        entry = _require_source(self._qp(qs, "source"))
        sid = entry["id"]
        if not callable(getattr(entry["module"], "depth", None)):
            raise HttpError(404, "not_supported",
                            "source %r does not implement depth" % sid, sid)
        venue = self._qp(qs, "venue") or ""
        symbol = _check_symbol(self._qp(qs, "symbol"), sid)
        limit = _parse_limit(self._qp(qs, "limit"), DEFAULT_DEPTH_LIMIT, sid)
        ttl = ttl_for(entry)
        key = "depth:%s:%s:%s:%d" % (sid, venue, symbol, limit)
        now_ms = int(time.time() * 1000)
        lock = _lock_for(key)
        with lock:
            hit = _CACHE.get(key)
            if hit and hit[0] > time.time():
                return hit[1]
            neg = _NEG.get(key)
            if neg and neg[0] > time.time():
                raise NegHit(neg[1], neg[2])
            try:
                depth = entry["module"].depth(venue, symbol, limit)
            except Exception as exc:
                err_body = {"error": "upstream",
                            "reason": (str(exc)[:500] or "upstream failure"),
                            "source": sid}
                _NEG[key] = (time.time() + ERROR_TTL, 502, err_body)
                raise NegHit(502, err_body)
            body = {"depth": depth,
                    "meta": {"source": sid, "venue": venue, "symbol": symbol,
                             "limit": limit, "cached_at": now_ms, "ttl": int(ttl)}}
            _CACHE[key] = (time.time() + ttl, body)
            _NEG.pop(key, None)
            return body


# ---------------------------------------------------------------- runner ---


def create_server(host: str = HOST, port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), Handler)


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="Opentape companion API (127.0.0.1 only)")
    ap.add_argument("--port", "-p", type=int, default=None)
    ap.add_argument("--host", default=HOST)
    ap.add_argument("port_pos", nargs="?", type=int, default=None,
                    help="positional port override")
    args = ap.parse_args(argv)
    port = args.port_pos or args.port or int(os.environ.get("OPENTAPE_PORT", DEFAULT_PORT))
    host = args.host or HOST
    if host not in ("127.0.0.1", "localhost", "::1"):
        print("refusing non-loopback host %r; binding %s" % (host, HOST),
              file=sys.stderr, flush=True)
        host = HOST
    server = create_server(host, port)
    print("opentape companion on http://%s:%d" % (host, port), flush=True)
    for sid, entry in REGISTRY.items():
        state = "ok" if entry["ok"] else "FAIL: %s" % entry.get("reason")
        print("  source %-12s %s" % (sid, state), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

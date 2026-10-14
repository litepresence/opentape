#!/usr/bin/env python3
"""Opentape launcher (workstream A).

Boots the static terminal plus the optional Python companion API:

  python3 opentape.py [--port 8787] [--companion-port 8788] [--open | --no-browser]

* Static server: ``python -m http.server`` rooted at this script's directory,
  bound to 127.0.0.1 (never 0.0.0.0).
* Companion: ``tooling/companion/server.py`` (port 8788) if present,
  otherwise prints a warning and continues with the terminal only.
* Probes companion ``/health`` before opening the page and prints a
  source-availability table (or a "companion absent" notice).
* Prints install hints for missing optional pip deps; never installs.
* Ctrl-C / SIGTERM stops both subprocesses cleanly (exit 0, ports freed).

Stdlib only. No secrets exist or are printed.
"""

import argparse
import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

HOST = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_COMPANION_PORT = 8788

# pip name, import name, hint note
OPTIONAL_DEPS = [
    ("yfinance", "yfinance", "stocks/equities source"),
    ("websocket-client", "websocket", "BitShares source"),
    ("akshare", "akshare", "China spot source"),
    ("baostock", "baostock", "China history source"),
]


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Launch the Opentape static terminal (8787) + "
        "optional companion API (8788)."
    )
    p.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help="Static terminal port (default %(default)s).",
    )
    p.add_argument(
        "--companion-port",
        type=int,
        default=DEFAULT_COMPANION_PORT,
        help="Companion API port (default %(default)s).",
    )
    p.add_argument(
        "--open",
        dest="open_browser",
        action="store_true",
        default=True,
        help="Open the terminal in a browser (default: on).",
    )
    p.add_argument(
        "--no-browser",
        dest="open_browser",
        action="store_false",
        help="Do not open a browser; just serve.",
    )
    args = p.parse_args(argv)
    for name, value in (("port", args.port), ("companion-port", args.companion_port)):
        if not 1 <= value <= 65535:
            p.error("--%s must be 1..65535 (got %r)" % (name, value))
    return args


def check_optional_deps():
    """Return [(pip_name, found_bool)]. Never imports heavy modules."""
    rows = []
    for pip_name, import_name, _note in OPTIONAL_DEPS:
        try:
            found = importlib.util.find_spec(import_name) is not None
        except Exception:
            found = False
        rows.append((pip_name, found))
    return rows


def print_dep_hints():
    print("[opentape] optional pip deps (missing ones only limit sources):")
    any_missing = False
    for (pip_name, _import_name, note), (_pip2, found) in zip(
        OPTIONAL_DEPS, check_optional_deps()
    ):
        status = "present" if found else "MISSING"
        print("  - %-16s %-7s  (%s)" % (pip_name, status, note))
        if not found:
            any_missing = True
            print("      hint: pip install %s" % pip_name)
    if not any_missing:
        print("  all optional deps present.")
    print("  (never auto-installed; install manually if you need that source)")


def fetch_health(base_url, timeout=2.0, attempts=15, interval=0.5):
    """GET base_url/health with retries. Returns (data_or_None, error_or_None)."""
    url = base_url.rstrip("/") + "/health"
    last_err = None
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                body = resp.read().decode("utf-8", "replace")
            try:
                return json.loads(body), None
            except json.JSONDecodeError:
                return {"_raw": body}, None
        except Exception as exc:  # URLError, timeout, connection refused, ...
            last_err = exc
            time.sleep(interval)
    return None, last_err


def wait_for_static(url, timeout=2.0, attempts=15, interval=0.3):
    """Wait until the static server answers. Returns True on success."""
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                resp.read(1)
            return True
        except Exception:
            time.sleep(interval)
    return False


def print_source_table(health):
    sources = health.get("sources", {}) if isinstance(health, dict) else {}
    if not isinstance(sources, dict) or not sources:
        print("[opentape] companion /health answered but reported no sources:")
        print("  %s" % json.dumps(health, sort_keys=True)[:500])
        return
    print("[opentape] companion sources (from /health):")
    print("  %-18s %-5s %s" % ("SOURCE", "OK", "DETAIL"))
    for sid in sorted(sources):
        info = sources[sid]
        if isinstance(info, dict):
            ok = info.get("ok", "?")
            detail = info.get("reason", "") or info.get("label", "")
        else:
            ok, detail = info, ""
        print("  %-18s %-5s %s" % (sid, ok, detail))
    if isinstance(health, dict) and health.get("time") is not None:
        print("  (companion time: %s)" % health["time"])


def companion_extra_args(server_path):
    """Decide whether the companion accepts a --port flag.

    Workstream B only guarantees `python3 tooling/companion/server.py`
    serves; it may or may not parse argv. Peek at the source: if it
    mentions --port/argparse/argv, pass --port; otherwise pass nothing
    (port travels via env) so a minimal server still boots.
    """
    try:
        with open(server_path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(65536)
    except OSError:
        return []
    markers = ("--port", "companion-port", "argparse", "sys.argv", "getopt")
    if any(m in head for m in markers):
        return ["--port"]
    return []


def start_static_server(port, root):
    cmd = [sys.executable, "-m", "http.server", str(port), "--bind", HOST]
    return subprocess.Popen(cmd, cwd=root)


def start_companion(server_path, port, root):
    extra = companion_extra_args(server_path)
    cmd = [sys.executable, server_path] + (
        extra + [str(port)] if extra == ["--port"] else extra
    )
    env = os.environ.copy()
    # Belt and suspenders: companions that read env still get the port
    # even when they ignore argv.
    env["PORT"] = str(port)
    env["OPENTAPE_COMPANION_PORT"] = str(port)
    return subprocess.Popen(cmd, cwd=root, env=env)


def stop_all(procs, timeout=5.0):
    for proc in procs:
        try:
            if proc.poll() is None:
                proc.terminate()
        except Exception:
            pass
    deadline = time.time() + timeout
    for proc in procs:
        if proc.poll() is not None:
            continue
        try:
            proc.wait(timeout=max(0.0, deadline - time.time()))
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
    for proc in procs:
        try:
            proc.wait(timeout=2.0)
        except Exception:
            pass


def main(argv=None):
    # Line-buffer stdout/stderr so status lines appear immediately even
    # when output is redirected to a file (block-buffered by default).
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(line_buffering=True)
        except Exception:
            pass
    args = parse_args(argv)
    root = os.path.dirname(os.path.abspath(__file__))
    static_url = "http://%s:%d/" % (HOST, args.port)
    companion_base = "http://%s:%d" % (HOST, args.companion_port)
    companion_path = os.path.join(root, "tooling", "companion", "server.py")

    procs = []
    companion_proc = None
    static_proc = None
    exit_code = 0

    def handle_sigterm(signum, frame):
        raise KeyboardInterrupt()

    try:
        signal.signal(signal.SIGTERM, handle_sigterm)
    except Exception:
        pass

    try:
        # --- static terminal (always) ---
        try:
            static_proc = start_static_server(args.port, root)
        except OSError as exc:
            print(
                "[opentape] ERROR: could not start static server on %s: %s"
                % (static_url, exc),
                file=sys.stderr,
            )
            return 1
        procs.append(static_proc)
        print("[opentape] static terminal: %s  (root=%s)" % (static_url, root))
        # Fail fast on port conflict / instant crash instead of serving
        # half-dead (another process on this port would still answer probes).
        time.sleep(0.5)
        if static_proc.poll() is not None:
            print(
                "[opentape] ERROR: static server failed to bind %s "
                "(port %d in use or bad args?). Stop the other server or "
                "use --port." % (static_url, args.port),
                file=sys.stderr,
            )
            stop_all(procs)
            return 1

        # --- companion (optional) ---
        if not os.path.isfile(companion_path):
            print(
                "[opentape] WARNING: companion absent at "
                "tooling/companion/server.py -- continuing with the "
                "terminal only (browser-direct CCXT path)."
            )
            print("[opentape] companion: absent (skipping /health probe)")
        else:
            try:
                companion_proc = start_companion(
                    companion_path, args.companion_port, root
                )
            except OSError as exc:
                print(
                    "[opentape] WARNING: could not launch companion: %s -- "
                    "continuing with the terminal only." % exc
                )
                companion_proc = None
            if companion_proc is not None:
                procs.append(companion_proc)
                print(
                    "[opentape] companion: %s  (probe %s/health)"
                    % (companion_base, companion_base)
                )
                # Give it a moment; a hard crash (bad argv, missing dep)
                # should degrade to terminal-only, not kill the launcher.
                time.sleep(0.5)
                if companion_proc.poll() is not None:
                    print(
                        "[opentape] WARNING: companion exited at startup "
                        "(code %s) -- continuing with the terminal only."
                        % companion_proc.returncode
                    )
                    try:
                        procs.remove(companion_proc)
                    except ValueError:
                        pass
                    companion_proc = None
                else:
                    health, err = fetch_health(companion_base)
                    if health is None:
                        print(
                            "[opentape] WARNING: companion /health "
                            "unreachable (%s) -- terminal still available; "
                            "companion features will show an error state."
                            % err
                        )
                    else:
                        print_source_table(health)

        # --- optional dep hints (always; informational) ---
        print_dep_hints()

        # --- readiness + browser ---
        if wait_for_static(static_url):
            print("[opentape] static server ready at %s" % static_url)
        else:
            print(
                "[opentape] WARNING: static server not answering yet at %s "
                "-- still opening/continuing; check the port." % static_url
            )
        if companion_proc is not None:
            print(
                "[opentape] serving: terminal %s  companion %s/health"
                % (static_url, companion_base)
            )
        else:
            print("[opentape] serving: terminal %s  (companion absent)" % static_url)
        if args.open_browser:
            try:
                webbrowser.open(static_url)
                print("[opentape] opened browser at %s" % static_url)
            except Exception as exc:
                print("[opentape] WARNING: could not open browser: %s" % exc)
        print("[opentape] Ctrl-C to stop (frees ports %s%s)." % (
            args.port,
            ("/%s" % args.companion_port) if companion_proc is not None else "",
        ))

        # --- supervise until Ctrl-C ---
        while True:
            if static_proc is not None and static_proc.poll() is not None:
                print(
                    "[opentape] ERROR: static server exited (code %s)."
                    % static_proc.returncode,
                    file=sys.stderr,
                )
                exit_code = 1
                break
            if companion_proc is not None and companion_proc.poll() is not None:
                print(
                    "[opentape] WARNING: companion exited mid-run (code %s) "
                    "-- terminal continues." % companion_proc.returncode
                )
                try:
                    procs.remove(companion_proc)
                except ValueError:
                    pass
                companion_proc = None
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[opentape] Ctrl-C received -- stopping servers...")
        exit_code = 0
    finally:
        stop_all(procs)
        print("[opentape] stopped. Ports freed.")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())

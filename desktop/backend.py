"""Tauri-owned Vibe Reader server; the legacy browser entry stays in server.py."""

import argparse
import hmac
import json
import os
import re
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit


PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))
from server import IMPORT_DIR, DocumentStore, ThreadingHTTPServer, build_handler  # noqa: E402


def main():
    if os.environ.get("APP_DESKTOP_MANAGED") != "1":
        raise RuntimeError("Desktop backend must be started by Tauri")
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--library", action="append", type=Path, default=[])
    parser.add_argument("--parallel-library", action="append", type=Path, default=[])
    parser.add_argument("--import-dir", type=Path, default=IMPORT_DIR)
    args = parser.parse_args()
    if args.instance_id != os.environ.get("APP_INSTANCE_ID"):
        raise RuntimeError("Instance identity mismatch")

    token = os.environ["APP_CONTROL_TOKEN"]
    parent_pid = int(os.environ["APP_PARENT_PID"])
    store = DocumentStore(args.library or [args.import_dir], import_dir=args.import_dir,
                          parallel_roots=args.parallel_library)
    base_handler = build_handler(store)
    stopping = threading.Event()
    lock = threading.Lock()
    import_lock = threading.Lock()
    preferences_lock = threading.Lock()
    preferences_path = Path(os.environ.get(
        "APP_PREFERENCES_FILE",
        str(Path.home() / "Library/Application Support/Vibe-Reader-Desktop/preferences.json"),
    ))
    try:
        preferences = json.loads(preferences_path.read_text(encoding="utf-8")) if preferences_path.exists() else {}
        if not isinstance(preferences, dict):
            raise ValueError("preferences must be an object")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Could not read desktop preferences: {error}", flush=True)
        preferences = None  # Preserve an unreadable file instead of overwriting it.
    active_jobs = 0

    def write_preferences():
        preferences_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=preferences_path.parent,
                                         prefix=".preferences-", suffix=".tmp", delete=False) as temporary:
            json.dump(preferences, temporary, ensure_ascii=False)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        try:
            os.replace(temporary_path, preferences_path)
        finally:
            temporary_path.unlink(missing_ok=True)

    def status():
        with lock:
            active = active_jobs
        return {"busy": active > 0, "active": active, "stopping": stopping.is_set()}

    class ManagedHandler(base_handler):
        def log_message(self, format_string, *values):
            if values and ("/_desktop/status" in values[0] or "/_desktop/health" in values[0]
                           or "/api/desktop-preferences" in values[0]):
                return
            super().log_message(format_string, *values)

        def authorized(self):
            header = self.headers.get("Authorization", "")
            if not hmac.compare_digest(header, "Bearer " + token):
                self.send_error_json("Forbidden", 403)
                return False
            return True

        def do_GET(self):  # noqa: N802
            path = urlsplit(self.path).path
            if path == "/api/desktop-preferences":
                if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
                    self.send_error_json("Forbidden", 403)
                    return
                with preferences_lock:
                    if preferences is None:
                        self.send_error_json("Preferences file is unreadable.", 500)
                    else:
                        self.send_json({"preferences": preferences})
                return
            if path in ("/_desktop/health", "/_desktop/status"):
                if not self.authorized():
                    return
                self.send_json({"ok": True, "pid": os.getpid(), **status()})
                return
            super().do_GET()

        def do_POST(self):  # noqa: N802
            nonlocal active_jobs
            path = urlsplit(self.path).path
            if path in ("/_desktop/prepare-exit", "/_desktop/shutdown"):
                if not self.authorized():
                    return
                stopping.set()
                self.send_json({"ok": True, **status()})
                if path.endswith("/shutdown"):
                    threading.Thread(target=httpd.shutdown, daemon=True).start()
                return
            if path == "/api/desktop-preferences":
                expected_origin = f"http://127.0.0.1:{self.server.server_port}"
                if (self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}"
                        or self.headers.get("Origin", expected_origin) != expected_origin
                        or not self.headers.get("Content-Type", "").startswith("application/json")):
                    self.send_error_json("Forbidden", 403)
                    return
                with lock:
                    if stopping.is_set():
                        self.send_error_json("App is closing.", 503)
                        return
                    active_jobs += 1
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= 4096:
                        raise ValueError("Invalid preference payload size")
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                    key, value = payload["key"], payload["value"]
                    if (not isinstance(key, str) or not isinstance(value, str) or len(value) > 512
                            or not (key in ("vibe-reader:font-size", "vibe-reader:last-document")
                                    or re.fullmatch(r"vibe-reader:scroll:[0-9a-f]{16}", key))):
                        raise ValueError("Invalid preference key or value")
                    with preferences_lock:
                        if preferences is None:
                            self.send_error_json("Preferences file is unreadable.", 500)
                            return
                        preferences[key] = value
                        write_preferences()
                    self.send_json({"ok": True})
                except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
                    self.send_error_json(str(error), 400)
                except OSError as error:
                    self.send_error_json(f"Could not save preferences: {error}", 500)
                finally:
                    with lock:
                        active_jobs -= 1
                return
            if path != "/api/import":
                super().do_POST()
                return
            with lock:
                if stopping.is_set():
                    self.send_error_json("App is closing.", 503)
                    return
                active_jobs += 1
            try:
                with import_lock:
                    super().do_POST()
            finally:
                with lock:
                    active_jobs -= 1

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ManagedHandler)

    def watch_parent():
        while True:
            if os.getppid() != parent_pid:
                stopping.set()
                deadline = time.monotonic() + 5
                while status()["busy"] and time.monotonic() < deadline:
                    time.sleep(0.1)
                os._exit(0)
            time.sleep(1)

    threading.Thread(target=watch_parent, daemon=True).start()
    serving = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
    serving.start()
    print("APP_BACKEND_READY " + json.dumps({"port": httpd.server_port, "pid": os.getpid()}), flush=True)
    serving.join()
    httpd.server_close()


if __name__ == "__main__":
    main()

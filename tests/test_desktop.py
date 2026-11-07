"""Desktop protocol and in-flight document import shutdown contract."""

import http.client
import json
import os
import select
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import uuid
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]


class DesktopLifecycleTests(unittest.TestCase):
    def test_preferences_survive_new_backend_session(self):
        with tempfile.TemporaryDirectory() as directory:
            preferences_path = Path(directory) / "preferences.json"

            def start():
                instance = str(uuid.uuid4())
                token = uuid.uuid4().hex
                env = dict(os.environ, APP_DESKTOP_MANAGED="1", APP_INSTANCE_ID=instance,
                           APP_CONTROL_TOKEN=token, APP_PARENT_PID=str(os.getpid()),
                           APP_PROJECT_ROOT=str(PROJECT), APP_PREFERENCES_FILE=str(preferences_path),
                           PYTHONUNBUFFERED="1")
                process = subprocess.Popen(
                    [sys.executable, str(PROJECT / "desktop/backend.py"),
                     "--import-dir", directory, "--library", directory,
                     "--instance-id", instance],
                    cwd=PROJECT, env=env, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, text=True,
                )
                line = process.stdout.readline()
                self.assertTrue(line.startswith("APP_BACKEND_READY "), line)
                port = json.loads(line.split(" ", 1)[1])["port"]
                return process, port, token

            def request(port, path, method="GET", payload=None, token=None):
                headers = {"Content-Type": "application/json"}
                if token:
                    headers["Authorization"] = "Bearer " + token
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}{path}", method=method,
                    data=json.dumps(payload).encode() if payload else None,
                    headers=headers,
                )
                with urllib.request.urlopen(req, timeout=3) as response:
                    return json.load(response)

            process, port, token = start()
            try:
                self.assertEqual(request(port, "/api/desktop-preferences")["preferences"], {})
                request(port, "/api/desktop-preferences", "POST",
                        {"key": "vibe-reader:font-size", "value": "21"})
                request(port, "/api/desktop-preferences", "POST",
                        {"key": "vibe-reader:last-document", "value": "0123456789abcdef"})
                request(port, "/_desktop/shutdown", "POST", token=token)
                process.wait(timeout=5)
                self.assertEqual(process.returncode, 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)
                process.stdout.close()

            process, port, token = start()
            try:
                saved = request(port, "/api/desktop-preferences")["preferences"]
                self.assertEqual(saved["vibe-reader:font-size"], "21")
                self.assertEqual(saved["vibe-reader:last-document"], "0123456789abcdef")
                request(port, "/_desktop/shutdown", "POST", token=token)
                process.wait(timeout=5)
                self.assertEqual(process.returncode, 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)
                process.stdout.close()

    def test_prepare_exit_drains_inflight_import(self):
        with tempfile.TemporaryDirectory() as directory:
            instance = str(uuid.uuid4())
            token = uuid.uuid4().hex
            env = dict(os.environ, APP_DESKTOP_MANAGED="1", APP_INSTANCE_ID=instance,
                       APP_CONTROL_TOKEN=token, APP_PARENT_PID=str(os.getpid()),
                       APP_PROJECT_ROOT=str(PROJECT), PYTHONUNBUFFERED="1")
            process = subprocess.Popen(
                [sys.executable, str(PROJECT / "desktop/backend.py"),
                 "--import-dir", directory, "--library", directory,
                 "--instance-id", instance],
                cwd=PROJECT, env=env, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True,
            )
            try:
                ready = None
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and ready is None:
                    readable, _, _ = select.select([process.stdout], [], [], 0.1)
                    if readable:
                        line = process.stdout.readline()
                        if line.startswith("APP_BACKEND_READY "):
                            ready = json.loads(line.split(" ", 1)[1])
                self.assertIsNotNone(ready)
                port = ready["port"]

                def control(path, method="GET"):
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{port}{path}", method=method,
                        headers={"Authorization": "Bearer " + token},
                    )
                    with urllib.request.urlopen(request, timeout=3) as response:
                        return json.load(response)

                payload = json.dumps({"filename": "desktop-test.md", "content": "# 完整写入\n"}).encode()
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                connection.putrequest("POST", "/api/import")
                connection.putheader("Content-Length", str(len(payload)))
                connection.endheaders()
                connection.send(payload[:10])
                for _ in range(30):
                    if control("/_desktop/status")["busy"]:
                        break
                    time.sleep(0.05)
                self.assertTrue(control("/_desktop/status")["busy"])
                self.assertTrue(control("/_desktop/prepare-exit", "POST")["stopping"])
                connection.send(payload[10:])
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                response.read()
                connection.close()
                self.assertEqual((Path(directory) / "desktop-test.md").read_text(), "# 完整写入\n")
                self.assertFalse(control("/_desktop/status")["busy"])
                control("/_desktop/shutdown", "POST")
                process.wait(timeout=5)
                self.assertEqual(process.returncode, 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)
                process.stdout.close()


if __name__ == "__main__":
    unittest.main()

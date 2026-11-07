from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

from server import DocumentStore, build_handler  # noqa: E402


class DocumentStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.import_dir = self.root / "imports"
        self.source = self.root / "book.md"
        self.source.write_text(
            "---\ntitle: \"A Test Book\"\n---\n\n# Opening\n\nFirst paragraph.\n\n"
            "A passage about Big Apple and dubstep.\n",
            encoding="utf-8",
        )
        self.store = DocumentStore([self.root], import_dir=self.import_dir)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_scan_extracts_title_and_source_line_count(self) -> None:
        documents = self.store.list_documents()
        self.assertEqual(len(documents), 1)
        self.assertEqual(documents[0]["title"], "A Test Book")
        self.assertEqual(documents[0]["line_count"], 9)

    def test_search_returns_source_line(self) -> None:
        result = self.store.search("Big Apple")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["line"], 9)
        self.assertIn("dubstep", result[0]["snippet"])

    def test_search_keeps_late_match_visible_and_returns_its_line(self) -> None:
        self.source.write_text("# Book\n\n" + "intro " * 100 + "\nEvidence about Big Apple.\n", encoding="utf-8")
        result = self.store.search("Big Apple")[0]
        self.assertEqual(result["line"], 4)
        self.assertEqual(result["start_line"], 3)
        self.assertIn("Big Apple", result["snippet"])

    def test_resolve_distinguishes_duplicate_names_and_relative_paths(self) -> None:
        for folder in ["one", "two"]:
            (self.root / folder).mkdir()
            (self.root / folder / "中文 材料.md").write_text(folder, encoding="utf-8")
        self.assertEqual(len(self.store.resolve_documents("中文 材料.md")), 2)
        resolved = self.store.resolve_documents("two/中文 材料.md")
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0]["relative_path"], "two/中文 材料.md")
        self.assertEqual(self.store.resolve_documents("../not-indexed.md"), [])

    def test_scan_does_not_follow_files_outside_library(self) -> None:
        with tempfile.TemporaryDirectory() as other:
            external = Path(other) / "private.md"
            external.write_text("outside the library", encoding="utf-8")
            (self.root / "external.md").symlink_to(external)
            self.assertEqual(len(self.store.list_documents()), 1)
            self.assertEqual(self.store.resolve_documents(str(external)), [])

    def test_import_uses_a_safe_unique_filename(self) -> None:
        first = self.store.import_document("../notes.md", "one")
        second = self.store.import_document("../notes.md", "two")
        self.assertEqual(first["name"], "notes.md")
        self.assertEqual(second["name"], "notes-2.md")
        self.assertEqual((self.import_dir / "notes.md").read_text(encoding="utf-8"), "one")

    def test_asset_access_is_limited_to_document_root_and_images(self) -> None:
        asset = self.root / "figure.png"
        asset.write_bytes(b"not-a-real-png")
        document_id = self.store.list_documents()[0]["id"]
        self.assertEqual(self.store.get_asset(document_id, "figure.png"), asset.resolve())
        self.assertIsNone(self.store.get_asset(document_id, "../outside.png"))
        self.assertIsNone(self.store.get_asset(document_id, "book.md"))


class HTTPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self.temporary_directory.name)
        (root / "document.md").write_text("# Hello\n\nUseful evidence.", encoding="utf-8")
        store = DocumentStore([root], import_dir=root / "imports")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), build_handler(store))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary_directory.cleanup()

    def get_json(self, path: str) -> dict:
        with urllib.request.urlopen(self.base_url + path, timeout=3) as response:
            return json.loads(response.read().decode("utf-8"))

    def test_health_and_document_endpoints(self) -> None:
        self.assertEqual(self.get_json("/api/health"), {"status": "ok"})
        documents = self.get_json("/api/documents")["documents"]
        self.assertEqual(len(documents), 1)
        document = self.get_json(f"/api/documents/{documents[0]['id']}")
        self.assertIn("Useful evidence", document["content"])

    def test_search_endpoint(self) -> None:
        result = self.get_json("/api/search?q=Useful")
        self.assertEqual(result["results"][0]["line"], 3)

    def test_filename_resolution_endpoint(self) -> None:
        matches = self.get_json("/api/resolve?file=document.md")["documents"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["name"], "document.md")
        self.assertEqual(self.get_json("/api/resolve?file=missing.md")["documents"], [])


if __name__ == "__main__":
    unittest.main()

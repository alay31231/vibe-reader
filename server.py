#!/usr/bin/env python3
"""A small, dependency-free local server for Vibe Reader."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import tempfile
import threading
import urllib.parse
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterable
from bilingual import load_parallel


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
IMPORT_DIR = APP_DIR / "library"
SUPPORTED_EXTENSIONS = {".md", ".markdown", ".txt"}
SUPPORTED_ASSET_EXTENSIONS = {".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"}
MAX_IMPORT_BYTES = 25 * 1024 * 1024
EXCLUDED_DIRECTORY_NAMES = {
    ".git",
    ".agents",
    ".codex",
    ".idea",
    ".vscode",
    "__pycache__",
    "node_modules",
    "vibe-reader",
}


def utc_timestamp(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


def document_id(path: Path) -> str:
    digest = hashlib.sha1(str(path.resolve()).encode("utf-8")).hexdigest()
    return digest[:16]


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def extract_title(text: str, fallback: str) -> str:
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        for line in lines[1:80]:
            if line.strip() == "---":
                break
            match = re.match(r"^title\s*:\s*(.+?)\s*$", line, flags=re.I)
            if match:
                return match.group(1).strip().strip("\"'") or fallback

    for line in lines[:120]:
        match = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if match:
            return match.group(1).strip().strip("# ") or fallback
    return fallback


def iter_blocks(text: str) -> Iterable[tuple[int, int, str]]:
    """Yield source-line-aware text blocks for lightweight full-text search."""
    lines = text.splitlines()
    start: int | None = None
    collected: list[str] = []

    def flush(end_line: int) -> tuple[int, int, str] | None:
        nonlocal start, collected
        if start is None or not collected:
            start = None
            collected = []
            return None
        block = (start, end_line, "\n".join(collected).strip())
        start = None
        collected = []
        return block

    for index, line in enumerate(lines, start=1):
        if not line.strip():
            block = flush(index - 1)
            if block:
                yield block
            continue
        if start is None:
            start = index
        collected.append(line)

    block = flush(len(lines))
    if block:
        yield block


@dataclass(frozen=True)
class Document:
    id: str
    path: Path
    root: Path

    def metadata(self, include_text: bool = False) -> dict[str, object]:
        stat = self.path.stat()
        text = read_text(self.path)
        relative_path = str(self.path.relative_to(self.root))
        payload: dict[str, object] = {
            "id": self.id,
            "name": self.path.name,
            "title": extract_title(text, self.path.stem),
            "relative_path": relative_path,
            "library": self.root.name,
            "modified_at": utc_timestamp(stat.st_mtime),
            "size": stat.st_size,
            "line_count": len(text.splitlines()),
        }
        if include_text:
            payload["content"] = text
        return payload


class DocumentStore:
    def __init__(self, roots: Iterable[Path], import_dir: Path = IMPORT_DIR, parallel_roots: Iterable[Path] = ()):
        self.parallel_roots = {root.expanduser().resolve() for root in parallel_roots}
        self.parallel_cache: dict[Path, tuple[object, dict]] = {}
        resolved_roots: list[Path] = []
        for root in [*roots, *sorted(self.parallel_roots), import_dir]:
            resolved = root.expanduser().resolve()
            if resolved not in resolved_roots:
                resolved_roots.append(resolved)
        self.roots = resolved_roots
        self.import_dir = import_dir.resolve()
        self.import_dir.mkdir(parents=True, exist_ok=True)

    def _iter_files(self, root: Path) -> Iterable[Path]:
        if not root.exists() or not root.is_dir():
            return

        for current_dir, directory_names, filenames in os.walk(root):
            current_path = Path(current_dir)
            if root != self.import_dir:
                directory_names[:] = [
                    name
                    for name in directory_names
                    if name not in EXCLUDED_DIRECTORY_NAMES and not name.startswith(".")
                ]
            for filename in filenames:
                if root in self.parallel_roots and not filename.endswith('.en.md'):
                    continue
                path = current_path / filename
                if path.suffix.lower() in SUPPORTED_EXTENSIONS and path.is_file():
                    resolved = path.resolve()
                    if resolved.is_relative_to(root):
                        yield resolved

    def scan(self) -> dict[str, Document]:
        documents: dict[str, Document] = {}
        seen_paths: set[Path] = set()
        for root in self.roots:
            for path in self._iter_files(root):
                if path in seen_paths:
                    continue
                seen_paths.add(path)
                item = Document(id=document_id(path), path=path, root=root)
                documents[item.id] = item
        return documents

    def list_documents(self) -> list[dict[str, object]]:
        items: list[dict[str, object]] = []
        for item in self.scan().values():
            try:
                items.append(self.metadata(item))
            except OSError:
                continue
        return sorted(items, key=lambda doc: str(doc["title"]).casefold())

    def get_document(self, doc_id: str) -> dict[str, object] | None:
        item = self.scan().get(doc_id)
        if item is None:
            return None
        try:
            return self.metadata(item, include_text=True)
        except OSError:
            return None

    def resolve_documents(self, filename: str) -> list[dict[str, object]]:
        """Resolve only indexed files; never open arbitrary paths supplied by a link."""
        name = filename.strip().replace("\\", "/")
        if not name:
            return []
        candidates = list(self.scan().values())
        exact = [item for item in candidates if name in {
            str(item.path), item.path.relative_to(item.root).as_posix()
        }]
        matches = exact or [item for item in candidates if item.path.name == name]
        return [self.metadata(item) for item in matches]

    def parallel(self, item: Document) -> dict | None:
        if item.root not in self.parallel_roots:
            return None
        target = item.path.with_name(item.path.name.removesuffix('.en.md') + '.zh.md')
        signature = (item.path.stat().st_mtime_ns, item.path.stat().st_size,
                     (target.stat().st_mtime_ns, target.stat().st_size) if target.is_file() else None)
        cached = self.parallel_cache.get(item.path)
        if cached is None or cached[0] != signature:
            cached = (signature, load_parallel(item.path))
            self.parallel_cache[item.path] = cached
        return cached[1]

    def metadata(self, item: Document, include_text: bool = False) -> dict:
        payload = item.metadata(include_text)
        parallel = self.parallel(item)
        if parallel:
            payload.update({key: parallel[key] for key in ('paragraph_count', 'translated_count', 'translation_available')})
            payload['doc_code'] = parallel['code']
            payload['title'] = parallel['title'] or payload['title']
            if include_text:
                payload['parallel'] = parallel
        return payload

    def resolve_code(self, code: str) -> list[dict]:
        return [item for item in self.list_documents() if item.get('doc_code', '').casefold() == code.strip().casefold()]

    def get_asset(self, doc_id: str, relative_path: str) -> Path | None:
        item = self.scan().get(doc_id)
        if item is None or not relative_path.strip():
            return None

        requested = Path(urllib.parse.unquote(relative_path))
        if requested.is_absolute() or requested.suffix.lower() not in SUPPORTED_ASSET_EXTENSIONS:
            return None
        candidate = (item.path.parent / requested).resolve()
        try:
            candidate.relative_to(item.root)
        except ValueError:
            return None
        if candidate.is_file():
            return candidate
        # Normalized texts retain image paths from the explicitly mounted raw library.
        original_root = (item.root.parent / '_markdown').resolve()
        if item.root in self.parallel_roots and original_root in self.roots:
            original = (original_root / item.path.relative_to(item.root).parent / requested).resolve()
            if original.is_relative_to(original_root) and original.is_file():
                return original
        return None

    def search(
        self, query: str, requested_doc_id: str | None = None, limit: int = 80
    ) -> list[dict[str, object]]:
        terms = [term.casefold() for term in query.split() if term.strip()]
        if not terms:
            return []

        documents = self.scan()
        if requested_doc_id:
            document = documents.get(requested_doc_id)
            candidates = [document] if document else []
        else:
            candidates = list(documents.values())
        candidates.sort(key=lambda item: item.root not in self.parallel_roots if item else True)

        results: list[dict[str, object]] = []
        for document in candidates:
            if document is None:
                continue
            try:
                text = read_text(document.path)
            except OSError:
                continue
            title = extract_title(text, document.path.stem)
            parallel = self.parallel(document)
            if parallel:
                title = parallel['title'] or title
                blocks = [(row['line'], row['end_line'], '\n'.join(p['text'] for p in row['source']) +
                           ('\n' + row['translation']['text'] if row['translation'] else ''), row['start'])
                          for row in parallel['rows'] if row['kind'] == 'pair']
            else:
                blocks = [(start, end, block, None) for start, end, block in iter_blocks(text)]
            for start_line, end_line, block, paragraph in blocks:
                haystack = block.casefold()
                if not all(term in haystack for term in terms):
                    continue
                compact = re.sub(r"\s+", " ", block).strip()
                # Keep the match visible even in a long source paragraph.
                match = re.search(re.escape(terms[0]), compact, re.IGNORECASE)
                offset = max(0, (match.start() if match else 0) - 100)
                snippet = compact[offset:offset + 300]
                compact = ("…" if offset else "") + snippet + ("…" if offset + 300 < len(compact) else "")
                matching_line = next((start_line + index for index, value in enumerate(block.splitlines())
                                      if terms[0] in value.casefold()), start_line)
                if paragraph is not None:
                    matching_line = start_line
                results.append(
                    {
                        "document_id": document.id,
                        "document_title": title,
                        "line": matching_line,
                        "start_line": start_line,
                        "end_line": end_line,
                        "snippet": compact,
                        "paragraph": paragraph,
                        "doc_code": parallel['code'] if parallel else None,
                    }
                )
                if len(results) >= limit:
                    return results
        return results

    def import_document(self, filename: str, content: str) -> dict[str, object]:
        safe_name = Path(filename).name.strip()
        safe_name = re.sub(r"[\x00-\x1f/:\\]", "-", safe_name)
        if not safe_name:
            safe_name = "untitled.md"
        if Path(safe_name).suffix.lower() not in SUPPORTED_EXTENSIONS:
            safe_name += ".md"

        encoded = content.encode("utf-8")
        if len(encoded) > MAX_IMPORT_BYTES:
            raise ValueError("Document is larger than the 25 MB import limit.")

        destination = self.import_dir / safe_name
        counter = 2
        while destination.exists():
            if read_text(destination) == content:
                item = Document(document_id(destination), destination, self.import_dir)
                return item.metadata()
            destination = self.import_dir / f"{Path(safe_name).stem}-{counter}{Path(safe_name).suffix}"
            counter += 1

        # Keep an existing library entry intact if the app is interrupted
        # while an imported document is being written.
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=self.import_dir, prefix=".vibe-import-", suffix=".tmp", delete=False
        ) as temporary:
            temporary.write(encoded)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        try:
            os.replace(temporary_path, destination)
        finally:
            temporary_path.unlink(missing_ok=True)
        item = Document(document_id(destination), destination, self.import_dir)
        return item.metadata()


def build_handler(store: DocumentStore):
    class VibeReaderHandler(BaseHTTPRequestHandler):
        server_version = "VibeReader/0.1"

        def log_message(self, format_string: str, *args: object) -> None:
            print(f"[{self.log_date_time_string()}] {format_string % args}")

        def send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def send_error_json(self, message: str, status: HTTPStatus) -> None:
            self.send_json({"error": message}, status=status)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            path = urllib.parse.unquote(parsed.path)

            if path == "/api/health":
                self.send_json({"status": "ok"})
                return
            if path == "/api/documents":
                self.send_json({"documents": store.list_documents()})
                return
            if path == "/api/resolve":
                parameters = urllib.parse.parse_qs(parsed.query)
                matches = (store.resolve_code(parameters['code'][0]) if 'code' in parameters else
                           store.resolve_documents(parameters.get("file", [""])[0]))
                self.send_json({"documents": matches})
                return
            if path.startswith("/api/documents/"):
                document_path = path.removeprefix("/api/documents/")
                if document_path.endswith("/asset"):
                    doc_id = document_path.removesuffix("/asset")
                    parameters = urllib.parse.parse_qs(parsed.query)
                    relative_path = parameters.get("path", [""])[0]
                    asset = store.get_asset(doc_id, relative_path)
                    if asset is None:
                        self.send_error_json("Asset not found.", HTTPStatus.NOT_FOUND)
                        return
                    self.serve_asset(asset)
                    return

                doc_id = document_path
                document = store.get_document(doc_id)
                if document is None:
                    self.send_error_json("Document not found.", HTTPStatus.NOT_FOUND)
                    return
                self.send_json(document)
                return
            if path == "/api/search":
                parameters = urllib.parse.parse_qs(parsed.query)
                query = parameters.get("q", [""])[0].strip()
                requested_doc_id = parameters.get("document_id", [None])[0]
                self.send_json(
                    {
                        "query": query,
                        "results": store.search(query, requested_doc_id=requested_doc_id),
                    }
                )
                return

            self.serve_static(path)

        def serve_asset(self, asset: Path) -> None:
            try:
                body = asset.read_bytes()
            except OSError:
                self.send_error_json("Asset not found.", HTTPStatus.NOT_FOUND)
                return
            content_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "private, max-age=3600")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/api/import":
                self.send_error_json("Endpoint not found.", HTTPStatus.NOT_FOUND)
                return

            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error_json("Invalid Content-Length.", HTTPStatus.BAD_REQUEST)
                return
            if content_length <= 0 or content_length > MAX_IMPORT_BYTES + 64 * 1024:
                self.send_error_json("Import payload is empty or too large.", HTTPStatus.BAD_REQUEST)
                return

            try:
                payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
                filename = str(payload["filename"])
                content = str(payload["content"])
                document = store.import_document(filename, content)
            except (json.JSONDecodeError, KeyError, TypeError, UnicodeDecodeError):
                self.send_error_json("Expected JSON with filename and content.", HTTPStatus.BAD_REQUEST)
                return
            except ValueError as error:
                self.send_error_json(str(error), HTTPStatus.BAD_REQUEST)
                return
            except OSError as error:
                self.send_error_json(f"Could not save document: {error}", HTTPStatus.INTERNAL_SERVER_ERROR)
                return

            self.send_json(document, status=HTTPStatus.CREATED)

        def serve_static(self, request_path: str) -> None:
            relative = "index.html" if request_path in {"", "/"} else request_path.lstrip("/")
            candidate = (STATIC_DIR / relative).resolve()
            try:
                candidate.relative_to(STATIC_DIR)
            except ValueError:
                self.send_error_json("Invalid path.", HTTPStatus.BAD_REQUEST)
                return

            if not candidate.is_file():
                candidate = STATIC_DIR / "index.html"
            try:
                body = candidate.read_bytes()
            except OSError:
                self.send_error_json("Static asset not found.", HTTPStatus.NOT_FOUND)
                return

            content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
                content_type += "; charset=utf-8"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data: https:; "
                "style-src 'self'; script-src 'self'; connect-src 'self';",
            )
            self.end_headers()
            self.wfile.write(body)

    return VibeReaderHandler


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local Vibe Reader service.")
    parser.add_argument(
        "--library",
        action="append",
        type=Path,
        help="Folder containing Markdown or text documents. May be repeated.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1).")
    parser.add_argument("--parallel-library", action="append", type=Path, default=[],
                        help="Folder of numbered .en.md / .zh.md pairs. May be repeated.")
    parser.add_argument("--port", default=35924, type=int, help="Port (default: 35924).")
    parser.add_argument("--open", action="store_true", help="Open the reader in the default browser.")
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    roots = arguments.library or [IMPORT_DIR]
    store = DocumentStore(roots, parallel_roots=arguments.parallel_library)
    server = ThreadingHTTPServer((arguments.host, arguments.port), build_handler(store))
    url = f"http://{arguments.host}:{arguments.port}"
    print(f"Vibe Reader is running at {url}")
    print("Press Ctrl+C to stop it.")

    if arguments.open:
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Vibe Reader.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

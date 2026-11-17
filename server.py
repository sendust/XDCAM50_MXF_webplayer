#!/usr/bin/env python3
"""MXF web player server.

Serves the static player (./public), a JSON listing of MXF files and the raw
MXF files themselves with full HTTP Range support, so the browser can fetch
only the bytes it needs (index tables, single GOPs) from multi-GB files.

    python3 server.py --root /mnt/raid0 --port 8080
"""
import argparse
import json
import mimetypes
import os
import re
import shutil
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "public")
MEDIA_EXT = (".mxf",)
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
COPY_BUF = 1 << 20

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")


class Handler(SimpleHTTPRequestHandler):
    server_version = "MXFWebPlayer/1.0"
    media_root = "/mnt/raid0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=PUBLIC, **kw)

    # quieter log: skip 206 spam
    def log_message(self, fmt, *args):
        if args and str(args[1]) in ("206", "304"):
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        # Cross-origin isolation lets the page use SharedArrayBuffer later (ffmpeg-core-mt)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def do_GET(self):
        self._route(head=False)

    def do_HEAD(self):
        self._route(head=True)

    def _route(self, head):
        path = unquote(urlsplit(self.path).path)
        if path == "/api/files":
            return self._list_files(head)
        if path.startswith("/media/"):
            return self._serve_media(path[len("/media/"):], head)
        if path.startswith("/vendor/"):
            # big immutable wasm: let the browser cache it
            self._cache_hint = True
        return super().do_HEAD() if head else super().do_GET()

    # ---------------------------------------------------------------- listing
    def _list_files(self, head):
        root = self.media_root
        items = []
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if not fn.lower().endswith(MEDIA_EXT):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                items.append({
                    "name": rel,
                    "url": "/media/" + quote(rel),
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                })
        items.sort(key=lambda x: x["name"])
        body = json.dumps({"root": root, "files": items}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not head:
            self.wfile.write(body)

    # ------------------------------------------------------------------ media
    def _resolve(self, rel):
        root = os.path.realpath(self.media_root)
        full = os.path.realpath(os.path.join(root, rel))
        if full != root and not full.startswith(root + os.sep):
            return None
        if not full.lower().endswith(MEDIA_EXT) or not os.path.isfile(full):
            return None
        return full

    def _serve_media(self, rel, head):
        full = self._resolve(rel)
        if not full:
            return self.send_error(HTTPStatus.NOT_FOUND)
        size = os.path.getsize(full)
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range")
        if rng:
            m = RANGE_RE.match(rng.strip())
            if not m or (not m.group(1) and not m.group(2)):
                return self._416(size)
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:  # suffix range: last N bytes
                n = int(m.group(2))
                start = max(0, size - n)
            end = min(end, size - 1)
            if start > end or start >= size:
                return self._416(size)
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", "application/mxf")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-cache")
        st = os.stat(full)
        self.send_header("Last-Modified", self.date_time_string(st.st_mtime))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head:
            return
        try:
            with open(full, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(COPY_BUF, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client cancelled (seek) - normal

    def _416(self, size):
        self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
        self.send_header("Content-Range", f"bytes */{size}")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_response(self, code, message=None):
        super().send_response(code, message)
        if getattr(self, "_cache_hint", False) and code == 200:
            self.send_header("Cache-Control", "public, max-age=604800, immutable")


def main():
    ap = argparse.ArgumentParser(description="MXF web player server")
    ap.add_argument("--root", default="/mnt/raid0", help="directory containing .mxf files")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    if not os.path.isdir(args.root):
        sys.exit(f"media root not found: {args.root}")
    Handler.media_root = os.path.realpath(args.root)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"MXF web player: http://{args.host}:{args.port}/  (media root: {Handler.media_root})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

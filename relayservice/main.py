#!/usr/bin/env python3
"""Relay HLS: recibe .ts / .m3u8 y los reenvía a YouTube. No procesa media."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import threading
import time
import urllib.error
import urllib.request

HOST = "0.0.0.0"
PORT = 4666
YOUTUBE = "https://a.upload.youtube.com/http_upload_hls?cid={key}&copy=0&file={file}"
ALIVE = 20.0
LIVE = {}
LOCK = threading.Lock()

MAX_TS = 8 * 1024 * 1024
MAX_M3U8 = 64 * 1024
MIN_TS = 188
MIN_M3U8 = 10

KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
FILE_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}\.(ts|m3u8)$", re.I)


def limits(name):
    if name.lower().endswith(".ts"):
        return MIN_TS, MAX_TS, "video/mp2t"
    return MIN_M3U8, MAX_M3U8, "application/vnd.apple.mpegurl"


def parse_path(path):
    parts = [p for p in path.split("?")[0].split("/") if p]
    if len(parts) != 2:
        return None, None
    key, name = parts
    if not KEY_RE.match(key) or not FILE_RE.match(name):
        return None, None
    return key, name


def touch(key):
    with LOCK:
        LIVE[key] = time.monotonic()


def active_ids():
    now = time.monotonic()
    with LOCK:
        for key, seen in list(LIVE.items()):
            if now - seen > ALIVE:
                del LIVE[key]
        return list(LIVE.keys())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _end(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, data):
        self._end(code, json.dumps(data).encode(), "application/json; charset=utf-8")

    def do_OPTIONS(self):
        self._end(204)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/health"):
            self._end(200, b"ok")
            return
        if path in ("/count", "/streams/count", "/streams", "/ids"):
            self._json(200, {"count": len(active_ids())})
            return
        self._end(404, b"not found")

    def do_PUT(self):
        self._ingest()

    def do_POST(self):
        self._ingest()

    def _read_body(self, cap):
        raw = self.headers.get("Content-Length")
        if raw is not None:
            try:
                n = int(raw)
            except ValueError:
                return None, b"bad content-length"
            if n < 0 or n > cap:
                return None, b"size not allowed"
            return self.rfile.read(n), None
        chunks = []
        got = 0
        while True:
            block = self.rfile.read(min(65536, cap + 1 - got))
            if not block:
                break
            got += len(block)
            if got > cap:
                return None, b"size not allowed"
            chunks.append(block)
        return b"".join(chunks), None

    def _ingest(self):
        key, name = parse_path(self.path)
        if not key:
            self._end(400, b"bad path: /{stream-key}/{file.ts|file.m3u8}")
            return

        lo, hi, ctype = limits(name)
        body, err = self._read_body(hi)
        if err:
            self._end(413, err)
            return
        if len(body) < lo:
            self._end(400, b"file too small")
            return
        if name.lower().endswith(".m3u8"):
            text = body.lstrip()
            if not text.startswith(b"#EXTM3U") or b"#EXTINF" not in text:
                self._end(400, b"playlist needs #EXTM3U and at least one #EXTINF")
                return
        if name.lower().endswith(".ts") and body[0] != 0x47:
            self._end(400, b"not a transport stream")
            return

        dest = YOUTUBE.format(key=key, file=name)
        req = urllib.request.Request(dest, data=body, method="POST")
        req.add_header("Content-Type", ctype)
        req.add_header("Content-Length", str(len(body)))
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                payload = res.read()
                if 200 <= res.status < 300:
                    touch(key)
                self._end(res.status, payload or b"ok")
        except urllib.error.HTTPError as exc:
            self._end(exc.code, exc.read() or str(exc).encode())
        except Exception as exc:
            self._end(502, f"youtube: {exc}".encode())


if __name__ == "__main__":
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"relay 0.0.0.0:{PORT}  PUT|POST /{{key}}/{{file}} -> youtube", flush=True)
    httpd.serve_forever()

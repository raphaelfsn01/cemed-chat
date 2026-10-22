"""Dublês HTTP do teste do backup (test-backup.sh): o Storage do Supabase e o
healthchecks.io, num servidor só.

  GET /storage/v1/object/authenticated/<bucket>/<path>
      exige Bearer + apikey = STUB_KEY; serve MEDIA_DIR/<bucket>/<path>;
      arquivo ausente responde como o Supabase: 400 com {"statusCode":"404"}.
  * /hc/<qualquer>   registra {path, query, body} em HC_LOG (uma linha JSON).
"""
import json
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = os.environ["STUB_KEY"]
MEDIA = os.environ["MEDIA_DIR"]
HC_LOG = os.environ["HC_LOG"]
PREFIX = "/storage/v1/object/authenticated/"


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _hc(self):
        url = urllib.parse.urlsplit(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        with open(HC_LOG, "a") as f:
            f.write(json.dumps({"path": url.path, "query": url.query, "body": body}) + "\n")
        self._send(200, b"OK", "text/plain")

    def do_POST(self):
        if self.path.startswith("/hc/"):
            return self._hc()
        self._send(404)

    def do_GET(self):
        if self.path.startswith("/hc/"):
            return self._hc()
        if not self.path.startswith(PREFIX):
            return self._send(404)
        if self.headers.get("Authorization") != "Bearer " + KEY or self.headers.get("apikey") != KEY:
            return self._send(401, b'{"statusCode":"401","error":"Unauthorized"}')
        rel = urllib.parse.unquote(self.path[len(PREFIX):])
        if rel.endswith("quebrado.jpg"):  # como o Storage real com arquivo sumido do disco
            return self._send(500, b'{"statusCode":"500","error":"Internal"}')
        path = os.path.realpath(os.path.join(MEDIA, rel))
        if not path.startswith(os.path.realpath(MEDIA) + os.sep) or not os.path.isfile(path):
            return self._send(400, b'{"statusCode":"404","error":"not_found","message":"Object not found"}')
        with open(path, "rb") as f:
            self._send(200, f.read(), "application/octet-stream")

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()

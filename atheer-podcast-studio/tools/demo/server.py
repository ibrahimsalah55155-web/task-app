"""Static server for the demo page + on-demand ProRes 4444 -> VP9-alpha conversion
(Chromium cannot play ProRes; the browser shows the same graphic as WebM).

    python server.py <port> <media_dir> <plugin_dist> <demo_dir>
"""

from __future__ import annotations

import hashlib
import mimetypes
import subprocess
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(sys.argv[1])
MEDIA = Path(sys.argv[2]).resolve()
PANEL = Path(sys.argv[3]).resolve()
DEMO = Path(sys.argv[4]).resolve()
CONV = MEDIA / "_conv"
CONV.mkdir(exist_ok=True)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        u = urllib.parse.urlparse(self.path)
        p = urllib.parse.unquote(u.path)
        if p in ("/", "/index.html"):
            html = (DEMO / "index.html").read_text(encoding="utf-8").replace("__MEDIA__", MEDIA.as_posix())
            data = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif p == "/convert":
            src = Path(urllib.parse.parse_qs(u.query)["path"][0])
            out = CONV / (hashlib.sha1(str(src).encode()).hexdigest()[:12] + ".webm")
            if not out.is_file():
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-vf", "scale=540:-2",
                                "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "2M", "-deadline", "realtime",
                                "-cpu-used", "8", "-auto-alt-ref", "0", str(out)], check=True)
            body = f"/media/_conv/{out.name}".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif p.startswith("/media/"):
            self._file(MEDIA / p[len("/media/"):])
        elif p.startswith("/panel/"):
            self._file(PANEL / p[len("/panel/"):])
        else:
            self._file(DEMO / p.lstrip("/"))


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

"""Serve site/ locally with caching disabled, so a normal refresh always shows the latest files.

Usage:
    python scripts/serve.py [port]    # default 8765, then open http://localhost:8765
"""

import functools
import http.server
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(NoCacheHandler, directory=str(SITE))
    print(f"Serving {SITE} at http://localhost:{port} (no caching)")
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()

#!/usr/bin/env python3
"""
Servidor local de desarrollo: igual que `python3 -m http.server`, pero con `Cache-Control: no-cache`
para que el navegador no sirva módulos JS viejos después de editarlos.

Uso (desde rutas-noviciado/):
  python3 tools/serve.py          # http://localhost:5180
  python3 tools/serve.py 8000
"""
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5180


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    print(f"Rutas Noviciado en http://localhost:{PORT}")
    http.server.ThreadingHTTPServer(("", PORT), handler).serve_forever()

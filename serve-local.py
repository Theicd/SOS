#!/usr/bin/env python3
"""Local SOS server — no browser/SW cache for HTML/JS."""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


def main():
    os.chdir(ROOT)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    httpd = ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler)
    print(f'Serving {ROOT} on http://127.0.0.1:{port}/ (Cache-Control: no-store)')
    httpd.serve_forever()


if __name__ == '__main__':
    main()

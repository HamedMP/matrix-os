#!/usr/bin/env python3
"""Receive the golden builder's phase callbacks during build-golden-disk.sh.

The unchanged builder cloud-init reports builder_booted, sanitized or failed
by POSTing JSON with a bearer token. On a metal host the platform is not in
the loop, so this receiver listens on the VM bridge (10.78.0.1:9480, reachable
only from the builder address by matrix_hostd's firewall) for the length of
one build and appends each accepted callback as one JSON line to --out.

Usage: golden-callback-receiver.py --bind ADDR --port N --token-file F --out FILE
"""
import argparse
import hmac
import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

MAX_BODY = 64 * 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    with open(args.token_file) as handle:
        token = handle.read().strip()
    if len(token) < 32:
        sys.exit("callback token too short")
    expected = f"Bearer {token}".encode()

    class Handler(BaseHTTPRequestHandler):
        timeout = 10

        def reply(self, status):
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            supplied = (self.headers.get("Authorization") or "").encode()
            if not hmac.compare_digest(supplied, expected):
                self.reply(401)
                return
            try:
                length = int(self.headers.get("Content-Length") or "-1")
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                self.reply(413)
                return
            try:
                payload = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeDecodeError):
                self.reply(400)
                return
            if not isinstance(payload, dict):
                self.reply(400)
                return
            record = {"receivedAt": datetime.now(timezone.utc).isoformat(), "payload": payload}
            fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a") as handle:
                handle.write(json.dumps(record, separators=(",", ":")) + "\n")
            self.reply(204)

        def log_message(self, fmt, *values):
            sys.stderr.write("golden-callback: " + (fmt % values) + "\n")

    HTTPServer((args.bind, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

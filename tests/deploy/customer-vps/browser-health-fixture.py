"""Loopback health contract fixture using the shipped supervisor startup state."""
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import hashlib
import json
import socket
import select
import subprocess
from threading import Thread


@contextmanager
def native_health_fixture():
    script = """
import { createSupervisor, createLabServer } from './scripts/spikes/browser-vps/supervisor.mjs';
const supervisor = createSupervisor();
const server = createLabServer(supervisor, '/unused', { status: async () => ({ available: true, chrome: { present: true } }) });
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, initial: supervisor.status() })));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
"""
    child = subprocess.Popen(['node', '--input-type=module', '-e', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    server = None
    try:
        # Node only starts a local HTTP server; process teardown is bounded below.
        if not select.select([child.stdout], [], [], 5)[0]:
            raise TimeoutError('Supervisor fixture startup exceeded five seconds')
        initial = json.loads(child.stdout.readline(4097))

        class Native(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path != '/json/version' and self.headers.get('Authorization') != 'Basic eDp5':
                    self.send_response(401)
                    self.end_headers()
                    return
                if self.headers.get('Upgrade') == 'websocket':
                    accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                    self.send_response(101)
                    for key, value in [('Upgrade', 'websocket'), ('Sec-WebSocket-Protocol', 'binary'), ('Sec-WebSocket-Accept', accept)]:
                        self.send_header(key, value)
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps({'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/browser/fixture'}).encode() if self.path == '/json/version' else b'viewer')

        server = ThreadingHTTPServer(('127.0.0.1', 0), Native)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        native_port = server.server_address[1]
        connect = socket.create_connection

        class Opener:
            @contextmanager
            def open(self, request, timeout):
                url = request if isinstance(request, str) else request.full_url
                port = initial['port'] if ':8730/' in url else native_port
                connection = HTTPConnection('127.0.0.1', port, timeout=timeout)
                connection._create_connection = connect
                headers = {} if isinstance(request, str) else dict(request.header_items())
                if ':8730/' in url:
                    headers['Host'] = '127.0.0.1:8730'
                connection.request('GET', '/' + url.split('/', 3)[3], headers=headers)
                response = connection.getresponse()
                response.url = url
                try:
                    yield response
                finally:
                    response.close()
                    connection.close()

        def run(arguments, **kwargs):
            if arguments[1:3] == ['-H', '-ltn']:
                return '\n'.join(f'LISTEN 0 20 127.0.0.1:{port} 0.0.0.0:*' for port in (6901, 8730, 9222))
            if arguments[1:3] != ['is-active', '--quiet']:
                raise AssertionError('Health must not mutate services or human input')
            return ''

        def viewer_connection(address, **kwargs):
            if address != ('127.0.0.1', 6901):
                raise AssertionError('Unexpected viewer address')
            return connect(('127.0.0.1', native_port), **kwargs)

        yield initial, Opener(), run, viewer_connection
    finally:
        if server:
            server.shutdown()
            server.server_close()
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
        child.stdout.close()
        child.stderr.close()

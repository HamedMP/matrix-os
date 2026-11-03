#!/usr/bin/python3
"""Root-only customer Browser lifecycle. Preview admission remains separate."""
import base64
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import secrets
import socket
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request


def viewer_location(source):
    location = 'location = /apps/browser-lab/viewer/websockify'
    if location in source:
        return source
    matches = list(re.finditer(r'^([ \t]*)location /apps/ \{[ \t]*$', source, re.M))
    if len(matches) != 1:
        raise ValueError('Browser requires one canonical app proxy')
    match = matches[0]
    indent = match.group(1)
    block = (f'{indent}{location} {{\n{indent}  proxy_http_version 1.1;\n'
             f'{indent}  proxy_set_header Upgrade $http_upgrade;\n'
             f'{indent}  proxy_set_header Connection "upgrade";\n'
             f'{indent}  proxy_read_timeout 600s;\n'
             f'{indent}  proxy_pass http://127.0.0.1:4000;\n{indent}}}\n\n')
    return source[:match.start()] + block + source[match.start():]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise ValueError('Browser health redirects are forbidden')


class Runtime:
    def __init__(self, root=Path('/'), uid=0, gid=None):
        self.root, self.uid = Path(root), uid
        self.gid = grp.getgrnam('matrix').gr_gid if gid is None else gid
        self.prefix = self.path('/opt/matrix-browser-lab')
        self.bin = self.path('/opt/matrix/bin')
        self.env = self.path('/opt/matrix/env/host.env')
        self.units = self.path('/etc/systemd/system')

    def path(self, value):
        return self.root / value.lstrip('/')

    def run(self, arguments, timeout=60, input=None):
        result = subprocess.run(arguments, check=True, timeout=timeout, input=input,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'DEBIAN_FRONTEND': 'noninteractive'})
        return result.stdout

    def directory(self, path, harden=False):
        relative = path.relative_to(self.root)
        current = self.root
        for part in relative.parts:
            current /= part
            try:
                info = current.lstat()
            except FileNotFoundError:
                current.mkdir(mode=0o755)
                self.sync_directory(current.parent)
                info = current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != self.uid:
                raise ValueError('Unsafe Browser directory')
            if info.st_mode & 0o022:
                # Fresh/golden hosts use root:matrix 0770 for /opt/matrix.
                # Harden only OS containers, never recurse into owner children.
                if harden and current in (self.path('/opt/matrix'), self.bin, self.path('/opt/matrix/env')) and not info.st_mode & 0o002:
                    descriptor = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        if os.fstat(descriptor).st_ino != info.st_ino:
                            raise ValueError('Browser directory changed')
                        os.fchmod(descriptor, 0o755)
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                else:
                    raise ValueError('Writable Browser ancestor')

    def prepare(self):
        for path in (self.bin, self.env.parent, self.units, self.prefix):
            self.directory(path, harden=True)

    def read(self, path, limit=131072):
        self.directory(path.parent)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != self.uid or info.st_mode & 0o022:
                raise ValueError('Unsafe Browser source')
            data = source.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Browser source too large')
        return data

    def sync_directory(self, path):
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != self.uid or info.st_mode & 0o022:
                raise ValueError('Unsafe Browser durability directory')
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def rename_durable(self, source, destination):
        source.rename(destination)
        self.sync_directory(source.parent)
        if destination.parent != source.parent:
            self.sync_directory(destination.parent)

    def unlink_durable(self, path, missing_ok=False):
        path.unlink(missing_ok=missing_ok)
        self.sync_directory(path.parent)

    def sync_payload(self, root):
        # Extraction already bounds count/bytes. Persist new file data and the
        # complete namespace before the journal can retire the rollback tree.
        for current, directories, files in os.walk(root, topdown=False):
            current = Path(current)
            if any((current / name).is_symlink() for name in directories):
                raise ValueError('Unsafe Browser durable payload')
            for name in files:
                descriptor = os.open(current / name, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    info = os.fstat(descriptor)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != self.uid or info.st_mode & 0o022:
                        raise ValueError('Unsafe Browser durable payload file')
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            self.sync_directory(current)

    def write(self, path, value, mode=0o644, gid=0):
        self.directory(path.parent)
        temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(12))
        try:
            descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
            with os.fdopen(descriptor, 'wb') as target:
                os.fchmod(target.fileno(), mode)
                if os.getuid() == 0:
                    os.fchown(target.fileno(), self.uid, gid)
                target.write(value.encode() if isinstance(value, str) else value)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, path)
            self.sync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)

    def extract(self, archive, destination):
        with tarfile.open(archive, 'r:gz') as source:
            members = source.getmembers()
            if len(members) > 4096 or sum(item.size for item in members) > 64 * 1024 * 1024:
                raise ValueError('Browser archive limit')
            names = set()
            for item in members:
                path = PurePosixPath(item.name)
                if path.is_absolute() or '..' in path.parts or item.name in names or not (item.isfile() or item.isdir()):
                    raise ValueError('Unsafe Browser archive')
                fixed = {'supervisor.mjs', 'native-windows.mjs', 'chrome-graceful-stop.mjs', 'safe-errors.mjs', 'runtime-services.json', 'invoices/fixture.mjs', 'invoices/original-pdf.mjs'}
                allowed_directory = item.name.rstrip('/') in {'invoices', 'lab', 'lab/dist'} or item.name.startswith('lab/dist/')
                if (item.isfile() and item.name not in fixed and not item.name.startswith('lab/dist/')) or (item.isdir() and not allowed_directory):
                    raise ValueError('Unexpected Browser payload file')
                names.add(item.name)
            source.extractall(destination, members=members, filter='data')
        # Normalize checkout modes; executable native payload is installed separately.
        for current, directories, files in os.walk(destination):
            Path(current).chmod(0o755)
            for name in files:
                (Path(current) / name).chmod(0o644)

    def installed_version(self):
        # BUNDLE_VERSION and app are intentionally owner-writable; read as data.
        # Root-owned release.json is the only committed artifact authority.
        app = self.path('/opt/matrix/app')
        if app.is_symlink() or not app.is_dir():
            raise ValueError('Invalid Browser app directory')
        descriptor = os.open(app / 'BUNDLE_VERSION', os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise ValueError('Invalid Browser version file')
            value = source.read(257)
        if len(value) > 256:
            raise ValueError('Browser version limit')
        return value.decode().strip()

    def environment(self):
        text = self.read(self.env).decode()
        values = {}
        for line in text.splitlines():
            if line.startswith(('MATRIX_MACHINE_ID=', 'MATRIX_HANDLE=', 'MATRIX_RUNTIME_SLOT=', 'MATRIX_CLERK_USER_ID=', 'MATRIX_USER_ID=', 'MATRIX_BROWSER_LAB=', 'MATRIX_BROWSER_LAB_VIEWER_AUTH=')):
                key, value = line.split('=', 1)
                if key in values:
                    raise ValueError('Duplicate Browser host configuration')
                values[key] = value.strip('"')
        if (not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', values.get('MATRIX_MACHINE_ID', ''))
            or not re.fullmatch(r'[a-z][a-z0-9-]{0,62}', values.get('MATRIX_HANDLE', ''))
            or values['MATRIX_HANDLE'].startswith(('pv-', 'pr-')) or values.get('MATRIX_RUNTIME_SLOT') != 'primary'
            or not re.fullmatch(r'user_[A-Za-z0-9]{1,128}', values.get('MATRIX_CLERK_USER_ID', ''))
            or values.get('MATRIX_USER_ID', values.get('MATRIX_CLERK_USER_ID')) != values.get('MATRIX_CLERK_USER_ID')
            or values.get('MATRIX_BROWSER_LAB', 'true') not in ('true', 'false')):
            raise ValueError('Customer Browser requires bound owner identity')
        return text, values

    def enable_environment(self):
        text, values = self.environment()
        if not re.fullmatch(r'Basic [A-Za-z0-9+/]+={0,2}', values.get('MATRIX_BROWSER_LAB_VIEWER_AUTH', '')):
            raise ValueError('Browser stream credential missing')
        lines = [line for line in text.splitlines() if not line.startswith('MATRIX_BROWSER_LAB=')]
        lines.append('MATRIX_BROWSER_LAB=true')
        self.write(self.env, '\n'.join(lines) + '\n', 0o640, self.gid)

    def credentials(self):
        text, values = self.environment()
        password_file, journal = self.prefix / 'viewer.passwd', self.prefix / 'credential-pending.json'
        if journal.exists() or journal.is_symlink():
            pending = json.loads(self.read(journal, 32768))
            authorization = pending['authorization']
            password_data = base64.b64decode(pending['passwordData'], validate=True)
            if not re.fullmatch(r'Basic [A-Za-z0-9+/]+={0,2}', authorization) or not password_data:
                raise ValueError('Invalid Browser pending credential')
            if values.get('MATRIX_BROWSER_LAB_VIEWER_AUTH', authorization) != authorization:
                raise ValueError('Browser credential changed during recovery')
            if password_file.exists() and self.read(password_file, 16384) != password_data:
                raise ValueError('Browser password changed during recovery')
            self.write(password_file, password_data, 0o640, self.gid)
            lines = [line for line in text.splitlines() if not line.startswith('MATRIX_BROWSER_LAB_VIEWER_AUTH=')]
            self.write(self.env, '\n'.join(lines) + '\nMATRIX_BROWSER_LAB_VIEWER_AUTH="' + authorization + '"\n', 0o640, self.gid)
            self.unlink_durable(journal)
            return
        configured = 'MATRIX_BROWSER_LAB_VIEWER_AUTH' in values
        exists = password_file.exists() or password_file.is_symlink()
        if exists or configured:
            if not exists or not configured:
                raise ValueError('Incomplete Browser credential pair; operator recovery required')
            self.read(password_file, 16384)
            if not re.fullmatch(r'Basic [A-Za-z0-9+/]+={0,2}', values['MATRIX_BROWSER_LAB_VIEWER_AUTH']):
                raise ValueError('Invalid Browser credential')
            return
        password = secrets.token_hex(32)
        temporary = self.prefix / ('.viewer.' + secrets.token_hex(12))
        try:
            self.run(['/usr/bin/kasmvncpasswd', '-u', 'matrix-browser-lab', '-r', '-w', str(temporary)],
                     input=password + '\n' + password + '\n', timeout=10)
            temporary.chmod(0o640)
            authorization = 'Basic ' + base64.b64encode(('matrix-browser-lab:' + password).encode()).decode()
            self.write(journal, json.dumps({'authorization': authorization,
                'passwordData': base64.b64encode(self.read(temporary, 16384)).decode()}), 0o600)
        finally:
            temporary.unlink(missing_ok=True)
        self.credentials()  # Durable pending pair is the only publish/recovery source.

    def download(self, url, target, checksum=None):
        self.run(['/usr/bin/curl', '--fail', '--location', '--proto', '=https', '--max-time', '180', '--retry', '2', url, '-o', str(target)], timeout=600)
        if checksum and hashlib.sha256(target.read_bytes()).hexdigest() != checksum:
            raise ValueError('Native Browser checksum mismatch')

    def dependencies(self):
        marker = self.prefix / 'dependencies-v1'
        if marker.exists():
            self.read(marker)
            for executable in ('/usr/bin/google-chrome-stable', '/usr/bin/Xvnc', '/usr/bin/wmctrl'):
                if not Path(executable).is_file():
                    raise ValueError('Native Browser dependency disappeared')
            return
        with tempfile.TemporaryDirectory(prefix='.dependencies-', dir=self.prefix) as temporary:
            temporary = Path(temporary)
            self.run(['/usr/bin/apt-get', 'update', '-qq'], timeout=300)
            self.run(['/usr/bin/apt-get', 'install', '-y', '--no-install-recommends', 'openbox', 'dbus-x11', 'xauth', 'x11-utils', 'xfonts-base', 'fonts-liberation', 'libnss3', 'libsecret-1-0', 'ca-certificates', 'curl', 'wmctrl', 'thunar', 'xfce4-terminal', 'xfdesktop4', 'tint2'], timeout=900)
            kasm = temporary / 'kasm.deb'
            self.download('https://github.com/kasmtech/KasmVNC/releases/download/v1.5.0/kasmvncserver_noble_1.5.0_amd64.deb', kasm, 'f599fe02e2175b9817b6165f74a5d2bebdc73118dde9181ba3410963bed7ae1e')
            chrome = temporary / 'chrome.deb'
            self.download('https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb', chrome)
            self.run(['/usr/bin/apt-get', 'install', '-y', str(kasm), str(chrome)], timeout=900)
            self.write(marker, json.dumps({'chromePackageSha256': hashlib.sha256(chrome.read_bytes()).hexdigest()}) + '\n')

    def check_listeners(self):
        ports = {6901, 8730, 9222}
        watched = ports | {5907}
        observed = set()
        for line in self.run(['/usr/bin/ss', '-H', '-ltn'], timeout=10).splitlines():
            fields = line.split()
            if len(fields) < 4:
                continue
            address, _, port = fields[3].rpartition(':')
            if port.isdigit() and int(port) in watched:
                if address not in ('127.0.0.1', '[::1]'):
                    raise ValueError('Public Browser listener refused')
                observed.add(int(port))
        if not ports.issubset(observed):
            raise ValueError('Browser listeners missing')

    def health(self):
        self.check_listeners()
        for name in self.service_names:
            self.run(['/usr/bin/systemctl', 'is-active', '--quiet', name], timeout=10)
        # Disable ambient HTTP proxies and redirects; only fixed loopback endpoints.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        for port, path, field in ((9222, '/json/version', 'webSocketDebuggerUrl'), (8730, '/browser-status', 'humanControlAvailable')):
            with opener.open(f'http://127.0.0.1:{port}{path}', timeout=5) as response:
                if response.url != f'http://127.0.0.1:{port}{path}':
                    raise ValueError('Unexpected Browser health redirect')
                data = response.read(65537)
                if len(data) > 65536:
                    raise ValueError('Browser health limit')
                result = json.loads(data)
                if (port == 9222 and not result.get(field)) or (port == 8730 and not isinstance(result.get(field), bool)):
                    raise ValueError('Browser native health unavailable')
                if port == 8730 and (result.get('available') is not True or result.get('chrome', {}).get('present') is not True):
                    raise ValueError('Browser Chrome window unavailable')
                if port == 9222 and not re.fullmatch(r'ws://127\.0\.0\.1:9222/devtools/browser/[A-Za-z0-9-]+', result[field]):
                    raise ValueError('Browser CDP is not loopback')

        _, values = self.environment()
        request = urllib.request.Request('http://127.0.0.1:6901/', headers={'Authorization': values.get('MATRIX_BROWSER_LAB_VIEWER_AUTH', '')})
        with opener.open(request, timeout=5) as response:
            if response.status != 200:
                raise ValueError('Browser viewer authentication unavailable')
            response.read(1)
        self.viewer_socket(values.get('MATRIX_BROWSER_LAB_VIEWER_AUTH', ''))

    def viewer_socket(self, authorization):
        key = base64.b64encode(os.urandom(16)).decode()
        request = (f'GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:6901\r\n'
                   f'Origin: http://127.0.0.1:6901\r\nAuthorization: {authorization}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                   f'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\nSec-WebSocket-Key: {key}\r\n\r\n')
        with socket.create_connection(('127.0.0.1', 6901), timeout=5) as connection:
            connection.sendall(request.encode())
            data = b''
            while b'\r\n\r\n' not in data:
                chunk = connection.recv(1024)
                if not chunk or len(data) + len(chunk) > 8192:
                    raise ValueError('Browser viewer handshake limit')
                data += chunk
        lines = data.decode('latin1').split('\r\n')
        headers = {key.lower(): value.strip() for line in lines[1:] if ':' in line for key, value in [line.split(':', 1)]}
        expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        if not re.fullmatch(r'HTTP/1\.[01] 101(?: .*)?', lines[0]) or headers.get('sec-websocket-accept') != expected or headers.get('upgrade', '').lower() != 'websocket' or headers.get('sec-websocket-protocol') != 'binary':
            raise ValueError('Browser authenticated viewer WebSocket unavailable')

    service_names = ('matrix-browser-lab-vnc.service', 'matrix-browser-lab-wm.service', 'matrix-browser-lab-desktop.service', 'matrix-browser-lab-panel.service', 'matrix-browser-lab-chrome.service', 'matrix-browser-lab.service')

    def destination(self, name):
        if name == 'nginx':
            return self.path('/etc/nginx/sites-available/matrix')
        if name == 'tint2rc':
            return self.prefix / name
        if name not in self.service_names:
            raise ValueError('Invalid Browser service name')
        return self.units / name

    def recover_activation(self):
        journal = self.prefix / 'activation.json'
        if not journal.exists() and not journal.is_symlink():
            return
        state = json.loads(self.read(journal, 512 * 1024))
        app, previous = self.prefix / 'app', self.prefix / '.previous'
        if app.is_symlink() or previous.is_symlink():
            raise ValueError('Unsafe Browser recovery tree')
        if not state['hadApp']:
            # Stop before deleting ExecStop scripts or unlinking the unit files.
            installed = [name for name in self.service_names if (self.units / name).is_file()]
            if installed:
                self.run(['/usr/bin/systemctl', 'disable', '--now', *installed])
        if previous.exists():
            if app.exists():
                shutil.rmtree(app)
                self.sync_directory(self.prefix)
            self.rename_durable(previous, app)
        elif not state['hadApp'] and app.exists():
            shutil.rmtree(app)
            self.sync_directory(self.prefix)
        current, values = self.environment()
        saved = base64.b64decode(state['environment'], validate=True).decode()
        # Activation owns only its Browser enablement. Gateway bootstrap owns
        # origin defaults; preserve all current origin/operator configuration,
        # identity/credentials/funded routing and explicit opt-out.
        lines = [line for line in current.splitlines() if not line.startswith('MATRIX_BROWSER_LAB=')]
        lines += [line for line in saved.splitlines() if line.startswith('MATRIX_BROWSER_LAB=')]
        if values.get('MATRIX_BROWSER_LAB') == 'false':
            lines = [line for line in lines if not line.startswith('MATRIX_BROWSER_LAB=')]
            lines.append('MATRIX_BROWSER_LAB=false')
        self.write(self.env, '\n'.join(lines) + '\n', 0o640, self.gid)
        for name, value in state['files'].items():
            destination = self.destination(name)
            if value is None:
                self.unlink_durable(destination, missing_ok=True)
            else:
                self.write(destination, base64.b64decode(value, validate=True))
        if 'nginx' in state['files']:
            self.run(['/usr/sbin/nginx', '-t'], timeout=10)
            self.run(['/usr/bin/systemctl', 'reload', 'nginx'])
        self.run(['/usr/bin/systemctl', 'daemon-reload'])
        if state['hadApp']:
            self.run(['/usr/bin/systemctl', 'restart', *self.service_names])
        self.run(['/usr/bin/systemctl', 'restart', 'matrix-gateway.service'])
        self.unlink_durable(journal)

    def activate(self, incoming, files):
        app, previous = self.prefix / 'app', self.prefix / '.previous'
        if app.is_symlink() or previous.exists() or previous.is_symlink():
            raise ValueError('Browser activation recovery required')
        old_files = {}
        changed = []
        for name, content in files.items():
            destination = self.destination(name)
            old_files[destination] = self.read(destination) if destination.exists() or destination.is_symlink() else None
            if old_files[destination] != content.encode():
                changed.append(name)
        old_environment = self.read(self.env)
        self.sync_payload(incoming)
        had_app = app.exists()
        self.write(self.prefix / 'activation.json', json.dumps({'hadApp': had_app,
            'environment': base64.b64encode(old_environment).decode(),
            'files': {name: (base64.b64encode(old_files[self.destination(name)]).decode() if old_files[self.destination(name)] is not None else None) for name in files}}), 0o600)
        try:
            if had_app:
                self.rename_durable(app, previous)
            self.rename_durable(incoming, app)
            for name, content in files.items():
                self.write(self.destination(name), content)
            if 'nginx' in files:
                self.run(['/usr/sbin/nginx', '-t'], timeout=10)
                self.run(['/usr/bin/systemctl', 'reload', 'nginx'])
            self.run(['/usr/bin/systemctl', 'daemon-reload'])
            self.run(['/usr/bin/systemctl', 'enable', '--now', *self.service_names])
            # Static native units keep Chrome/display PIDs and signed-in state on upgrades.
            restart = [name for name in changed if name.endswith('.service')]
            if 'matrix-browser-lab.service' not in restart:
                restart.append('matrix-browser-lab.service')
            self.run(['/usr/bin/systemctl', 'restart', *restart])
            failure = None
            for attempt in range(30):
                try:
                    self.health()
                    failure = None
                    break
                except (ValueError, OSError, subprocess.SubprocessError) as error:
                    failure = error
                    if attempt < 29:
                        time.sleep(2)
            if failure:
                raise ValueError('Browser health check failed') from failure
            self.enable_environment()
            self.run(['/usr/bin/systemctl', 'restart', 'matrix-gateway.service'])
        except BaseException:
            self.recover_activation()
            raise
        self.unlink_durable(self.prefix / 'activation.json')
        if previous.exists():
            shutil.rmtree(previous)
            self.sync_directory(self.prefix)

    def preflight(self):
        release = self.path('/etc/os-release').read_text()
        if 'ID=ubuntu\n' not in release or 'VERSION_ID="24.04"' not in release or os.uname().machine != 'x86_64':
            raise ValueError('Browser requires Ubuntu 24.04 x86_64')
        memory = self.path('/proc/meminfo').read_text()
        match = re.search(r'^MemTotal:\s+(\d+) kB$', memory, re.M)
        if not match or int(match.group(1)) < 2 * 1024 * 1024 or shutil.disk_usage(self.prefix).free < 2 * 1024 ** 3:
            raise ValueError('Browser requires 2 GiB RAM and free storage')

    def verified_archive(self):
        archive = self.bin / 'matrix-browser-runtime.tar.gz'
        checksum = self.read(archive.with_name(archive.name + '.sha256'), 128).decode().strip()
        if not re.fullmatch(r'[0-9a-f]{64}', checksum) or hashlib.sha256(self.read(archive, 64 * 1024 * 1024)).hexdigest() != checksum:
            raise ValueError('Browser payload checksum mismatch')
        return archive

    def product_status(self):
        _, values = self.environment()
        if values.get('MATRIX_BROWSER_LAB') == 'false':
            return {'status': 'disabled', 'retryAvailable': False}
        version = json.loads(self.read(self.path('/opt/matrix/release.json'))).get('version')
        if not isinstance(version, str) or not version or self.installed_version() != version:
            raise ValueError('Browser release unavailable')
        state_file, retry_file = self.prefix / 'status.json', self.prefix / 'retry.json'
        state = json.loads(self.read(state_file, 4096)) if state_file.exists() else {}
        status = state.get('status', 'pending') if state.get('version') == version else 'pending'
        if status not in ('pending', 'installing', 'ready', 'failed', 'exhausted', 'disabled'):
            raise ValueError('Invalid Browser lifecycle state')
        if status == 'ready':
            # One bounded activity probe exposes stopped/start-limited services
            # to owner recovery without running health or touching active input.
            states = self.run(['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', *self.service_names], timeout=2).split()
            if len(states) != len(self.service_names) or any(value not in ('active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading') for value in states):
                raise ValueError('Browser native activity unavailable')
            if any(value in ('inactive', 'failed') for value in states):
                status = 'failed'
            elif any(value != 'active' for value in states):
                status = 'installing'
        elif status == 'installing':
            active = self.run(['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', 'matrix-browser-runtime.service'], timeout=2).strip()
            if active in ('inactive', 'failed'):
                status = 'exhausted' if state.get('attempts', 0) >= 3 else 'failed'
            elif active not in ('activating', 'active', 'reloading'):
                raise ValueError('Browser lifecycle state unavailable')
        retried = json.loads(self.read(retry_file, 4096)) if retry_file.exists() else {}
        allowed = (retried.get('version') != version or time.time() - retried.get('requestedAt', time.time()) >= 3600)
        return {'status': status, 'retryAvailable': status in ('pending', 'failed', 'exhausted') and allowed}

    def retry(self):
        result = self.product_status()
        if not result['retryAvailable']:
            return result
        installed = []
        for name in self.service_names:
            unit = self.units / name
            try:
                info = unit.lstat()
            except FileNotFoundError:
                continue  # Initial setup can fail before native units exist.
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('Unsafe Browser native unit')
            self.read(unit, 32768)  # Root-owned, non-writable and no symlinks.
            installed.append(name)
        version = json.loads(self.read(self.path('/opt/matrix/release.json')))['version']
        self.write(self.prefix / 'retry.json', json.dumps({'version': version, 'requestedAt': time.time()}), 0o600)
        # Consume the budget before service calls; interruptions cannot create
        # an unbounded privileged restart loop. Preserve credentials/profile.
        state = {'version': version, 'attempts': 0, 'status': 'installing'}
        self.write(self.prefix / 'status.json', json.dumps(state))
        try:
            self.run(['/usr/bin/systemctl', 'reset-failed', 'matrix-browser-runtime.service', *installed], timeout=10)
            self.run(['/usr/bin/systemctl', 'start', '--no-block', 'matrix-browser-runtime.service'], timeout=10)
        except (OSError, subprocess.SubprocessError):
            state['status'] = 'failed'
            self.write(self.prefix / 'status.json', json.dumps(state))
            raise
        return {'status': 'installing', 'retryAvailable': False}

    def reconcile(self):
        self.prepare()
        self.recover_activation()  # Recovery is mandatory even after budget/opt-out.
        _, values = self.environment()
        if values.get('MATRIX_BROWSER_LAB') == 'false':
            self.write(self.prefix / 'status.json', '{"status":"disabled"}\n')
            return
        version = json.loads(self.read(self.path('/opt/matrix/release.json'))).get('version')
        if not isinstance(version, str) or not version or self.installed_version() != version:
            raise ValueError('Browser candidate release is not committed')
        state_file = self.prefix / 'status.json'
        state = json.loads(self.read(state_file)) if state_file.exists() else {}
        attempts = state.get('attempts', 0) if state.get('version') == version else 0
        if state.get('status') == 'ready' and state.get('version') == version:
            try:
                self.health()
                return
            except (ValueError, OSError, subprocess.SubprocessError):
                attempts = 0
        if attempts >= 3:
            self.write(state_file, json.dumps({'version': version, 'attempts': attempts, 'status': 'exhausted'}))
            return
        state = {'version': version, 'attempts': attempts + 1, 'status': 'installing'}
        self.write(state_file, json.dumps(state))
        try:
            self._reconcile()
            state['status'] = 'ready'
        except (ValueError, OSError, subprocess.SubprocessError):
            state['status'] = 'exhausted' if state['attempts'] >= 3 else 'failed'
            raise
        finally:
            self.write(state_file, json.dumps(state))

    def _reconcile(self):
        self.prepare()
        self.recover_activation()
        previous = self.prefix / '.previous'
        if previous.is_symlink():
            raise ValueError('Unsafe Browser completed rollback tree')
        if previous.exists():
            shutil.rmtree(previous)
        # Clean only root-owned abandoned work directories; never follow links.
        abandoned = []
        for child in self.prefix.iterdir():
            info = child.lstat()
            if (child.name.startswith(('.payload-', '.dependencies-')) and stat.S_ISDIR(info.st_mode) or child.name.startswith('.viewer.') and stat.S_ISREG(info.st_mode)) and info.st_uid == self.uid:
                abandoned.append((info.st_mtime, child))
        for index, (modified, child) in enumerate(sorted(abandoned, reverse=True)):
            if index >= 8 or modified < time.time() - 86400:
                shutil.rmtree(child) if child.is_dir() else child.unlink()
        self.environment()
        version = self.installed_version()
        # Refuse in-flight bundle candidates; scheduling is after core health commit.
        release = json.loads(self.read(self.path('/opt/matrix/release.json')))
        if release.get('version') != version:
            raise ValueError('Browser candidate release is not committed')
        installed = self.prefix / 'installed-release'
        if installed.exists() and self.read(installed, 256).decode().strip() == version:
            try:
                self.health()
                return
            except (ValueError, OSError, subprocess.SubprocessError):
                pass  # Explicitly repair failed native health, retaining data.
        self.preflight()
        self.verified_archive()
        owner = pwd.getpwnam('matrix')
        profile = self.path('/home/matrix/.local/share/matrix-browser-lab/chrome')
        local = self.path('/home/matrix/.local')
        owner_local = self.path('/home/matrix/home/.local')
        # Customer cloud-init keeps this exact compatibility alias. Preserve the
        # established Chrome path/profile; every other symlink remains refused.
        for path in (profile, *profile.parents):
            if path.is_symlink() and (path != local or path.readlink() != owner_local
                    or any(parent.is_symlink() for parent in (owner_local, *owner_local.parents))):
                raise ValueError('Unsafe Browser owner profile')
        self.dependencies()
        self.credentials()
        # Owner profile is never recursively chowned, copied, removed or reset.
        self.run(['/usr/sbin/runuser', '-u', 'matrix', '--', '/usr/bin/mkdir', '-p', str(profile)])
        if not profile.is_dir() or profile.stat().st_uid != owner.pw_uid:
            raise ValueError('Unsafe Browser owner profile')
        with tempfile.TemporaryDirectory(prefix='.payload-', dir=self.prefix) as temporary:
            incoming = Path(temporary) / 'app'
            incoming.mkdir()
            archive = self.verified_archive()
            self.extract(archive, incoming)
            files = json.loads((incoming / 'runtime-services.json').read_text())
            if set(files) != {*self.service_names, 'tint2rc'} or any(not isinstance(value, str) or len(value) > 32768 for value in files.values()):
                raise ValueError('Invalid Browser service payload')
            if json.loads(self.read(self.path('/opt/matrix/release.json'))).get('version') != version or self.installed_version() != version:
                raise ValueError('Browser release changed during reconciliation')
            nginx = self.path('/etc/nginx/sites-available/matrix')
            files['nginx'] = viewer_location(self.read(nginx).decode())
            self.activate(incoming, files)
        self.write(self.prefix / 'installed-release', version + '\n')


def main(arguments):
    if os.getuid() != 0 or arguments not in ([], ['--health-check'], ['--status'], ['--retry']):
        raise ValueError('Root-only Browser lifecycle')
    runtime = Runtime()
    runtime.prepare()
    if arguments == ['--status']:
        print(json.dumps(runtime.product_status()))
        return
    lock = os.open('/run/matrix-browser-runtime.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if arguments == ['--retry']:
                print(json.dumps({'status': 'installing', 'retryAvailable': False}))
                return
            raise
        if arguments == ['--retry']:
            print(json.dumps(runtime.retry()))
        elif arguments:
            runtime.health()
        else:
            runtime.reconcile()
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Customer Browser setup failed: ' + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)

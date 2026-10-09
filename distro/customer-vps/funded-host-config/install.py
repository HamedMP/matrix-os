"""Inlined trusted-updater bootstrap; TLS/checksum provenance is not a signature.

Never execute code from matrix-owned extraction. Existing owner sudo authority
is inherited; this mechanism does not isolate root from an owner administrator.
"""
import fcntl
import gzip
import hashlib
import http.client
import ipaddress
import json
import os
import re
import secrets
import ssl
import socket
import stat
import tarfile
import time
from urllib.parse import urlsplit, parse_qsl

PLATFORM = 'app.matrix-os.com'
MAX_ARCHIVE = 2 * 1024 ** 3
MAX_EXPANSION = 20 * 1024 ** 3
MEMBERS = {'funded-host-config/reconcile.py': 'matrix-funded-host-config.py',
           'funded-host-config/matrix-funded-host-config.service': 'matrix-funded-host-config.service'}


class ConfigError(Exception):
    pass


def require(condition):
    if not condition:
        raise ConfigError('configuration_deferred')


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def json_bytes(data):
    return json.loads(data, object_pairs_hook=unique)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Directory:
    """Pin every ancestor, reject rebinding and group/other writable roots."""
    def __init__(self, root, parts, uid=0, create=False):
        self.parts, self.uid, self.fds = parts, uid, []
        try:
            self.fds.append(os.open(root, os.O_DIRECTORY | os.O_NOFOLLOW))
            for part in parts:
                if create:
                    try:
                        os.mkdir(part, 0o755, dir_fd=self.fds[-1])
                    except FileExistsError:
                        pass
                self.fds.append(os.open(part, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fds[-1]))
            self.verify()
        except BaseException:
            self.close()
            raise

    def verify(self):
        for index, fd in enumerate(self.fds):
            info = os.fstat(fd)
            require(info.st_uid == self.uid and not info.st_mode & 0o022)
            if index:
                current = os.stat(self.parts[index - 1], dir_fd=self.fds[index - 1], follow_symlinks=False)
                require(stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino))

    def read(self, name, limit=1048576):
        self.verify()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fds[-1])
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == self.uid and info.st_nlink == 1
                    and not info.st_mode & 0o022 and info.st_size <= limit)
            data = os.read(fd, limit + 1)
            require(len(data) == info.st_size and len(data) <= limit)
            require(os.fstat(fd).st_mtime_ns == info.st_mtime_ns)
            self.verify()
            return data
        finally:
            os.close(fd)

    def write(self, name, data, mode):
        self.verify()
        require(re.fullmatch(r'[a-zA-Z0-9._-]{1,128}', name))
        try:
            current = os.stat(name, dir_fd=self.fds[-1], follow_symlinks=False)
            require(stat.S_ISREG(current.st_mode) and current.st_uid == self.uid
                    and current.st_nlink == 1 and not current.st_mode & 0o022)
        except FileNotFoundError:
            pass
        temporary = '.funded-' + secrets.token_hex(12)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fds[-1])
        try:
            with os.fdopen(fd, 'wb', closefd=False) as file:
                file.write(data)
                file.flush()
            os.fchmod(fd, mode)
            os.fsync(fd)
            self.verify()
            os.replace(temporary, name, src_dir_fd=self.fds[-1], dst_dir_fd=self.fds[-1])
            os.fsync(self.fds[-1])
            self.verify()
        finally:
            os.close(fd)
            try:
                os.unlink(temporary, dir_fd=self.fds[-1])
            except FileNotFoundError:
                pass

    def close(self):
        for fd in self.fds:
            os.close(fd)
        self.fds = []


def connection():
    # Fixed host; no urllib proxy, redirects, user CA overrides or TLS bypass.
    context = ssl.create_default_context(cafile='/etc/ssl/certs/ca-certificates.crt')
    return http.client.HTTPSConnection(PLATFORM, timeout=15, context=context)


def get(path, headers=None, sink=None, limit=65536, deadline=15, transport=None):
    require(path.startswith('/') and '\r' not in path and '\n' not in path)
    client = transport if transport is not None else connection()
    try:
        outgoing = dict(headers or {})
        outgoing['User-Agent'] = 'matrix-funded-host-config/1'
        client.request('GET', path, headers=outgoing)
        response = client.getresponse()
        require(response.status == 200)  # Redirects are errors; credentials never forwarded.
        end, count, chunks = time.monotonic() + deadline, 0, []
        while True:
            require(time.monotonic() <= end)
            chunk = response.read(min(65536, limit + 1 - count))
            if not chunk:
                break
            count += len(chunk)
            require(count <= limit)
            if sink is None:
                chunks.append(chunk)
            else:
                sink(chunk)
        return b''.join(chunks) if sink is None else count
    finally:
        client.close()


def artifact_target(value, version):
    require(isinstance(value, str) and 1 <= len(value) <= 8192 and value.isascii()
            and not any(character in value for character in ('\r', '\n', '\\')))
    parsed = urlsplit(value)
    require(parsed.scheme == 'https' and parsed.netloc == parsed.hostname and parsed.port is None
            and not parsed.username and not parsed.password and not parsed.fragment
            and re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,62}\.[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com', parsed.hostname or '')
            and parsed.path == '/system-bundles/' + version + '/matrix-host-bundle.tar.gz')
    pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    require(1 <= len(pairs) <= 10 and len({key for key, _ in pairs}) == len(pairs))
    params = dict(pairs)
    required = {'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature'}
    require(required <= set(params) <= required | {'X-Amz-Content-Sha256', 'x-id', 'x-amz-checksum-mode'}
            and params['X-Amz-Algorithm'] == 'AWS4-HMAC-SHA256'
            and re.fullmatch(r'[A-Za-z0-9]{1,128}/[0-9]{8}/auto/s3/aws4_request', params['X-Amz-Credential'])
            and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z', params['X-Amz-Date'])
            and re.fullmatch(r'[1-9][0-9]{0,5}', params['X-Amz-Expires'])
            and int(params['X-Amz-Expires']) <= 604800 and params['X-Amz-SignedHeaders'] == 'host'
            and re.fullmatch(r'[a-f0-9]{64}', params['X-Amz-Signature']))
    require(params.get('X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD') == 'UNSIGNED-PAYLOAD'
            and params.get('x-id', 'GetObject') == 'GetObject'
            and params.get('x-amz-checksum-mode', 'ENABLED') == 'ENABLED')
    return parsed.hostname, parsed.path + '?' + parsed.query


def public_addresses(host):
    addresses = {item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    require(0 < len(addresses) <= 16 and all(ipaddress.ip_address(ip).is_global for ip in addresses))
    return sorted(addresses)


class PinnedArtifactConnection(http.client.HTTPSConnection):
    def __init__(self, host, address):
        context = ssl.create_default_context(cafile='/etc/ssl/certs/ca-certificates.crt')
        super().__init__(host, timeout=15, context=context)
        self.address = address

    def connect(self):
        # Numeric peer prevents DNS rebinding between preflight and connect;
        # hostname remains TLS SNI/certificate name and HTTP Host identity.
        raw = socket.create_connection((self.address, 443), timeout=15)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
            require(ipaddress.ip_address(self.sock.getpeername()[0]) == ipaddress.ip_address(self.address))
        except BaseException:
            raw.close()
            raise


def get_artifact(meta, version, sink):
    host, path = artifact_target(meta.get('url'), version)
    addresses = public_addresses(host)
    # One attempt only; uncertain downloads never auto replay or change origins.
    return get(path, sink=sink, limit=meta['size'], deadline=180,
               transport=PinnedArtifactConnection(host, addresses[0]))


def validate_metadata(meta, version, source):
    require(isinstance(meta, dict) and meta.get('version') == version and meta.get('gitCommit') == source
            and re.fullmatch(r'[a-f0-9]{40}', source) and re.fullmatch(r'[A-Za-z0-9._-]{1,128}', version)
            and isinstance(meta.get('sha256'), str) and re.fullmatch(r'[a-f0-9]{64}', meta['sha256'])
            and type(meta.get('size')) is int and 0 < meta['size'] <= MAX_ARCHIVE)
    # Metadata URL is not configuration authority. The canonical metadata source
    # independently binds only source, version, archive hash and size here.
    return meta


def snapshot(source_fd, destination_fd, meta):
    before = os.fstat(source_fd)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size == meta['size'])
    os.lseek(source_fd, 0, os.SEEK_SET)
    hasher, count = hashlib.sha256(), 0
    end = time.monotonic() + 180
    while True:
        require(time.monotonic() < end)
        chunk = os.read(source_fd, 65536)
        if not chunk:
            break
        count += len(chunk)
        require(count <= meta['size'])
        hasher.update(chunk)
        offset = 0
        while offset < len(chunk):
            offset += os.write(destination_fd, chunk[offset:])
    require(count == meta['size'] and hasher.hexdigest() == meta['sha256'])
    after = os.fstat(source_fd)
    require((before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns))
    os.fsync(destination_fd)
    os.lseek(destination_fd, 0, os.SEEK_SET)


class BoundedTarInfo(tarfile.TarInfo):
    def _proc_member(self, archive):
        # Extension headers are processed before the public member iterator.
        # Bound them before tarfile allocates their declared bodies.
        require(self.size >= 0 and self.type != tarfile.GNUTYPE_SPARSE)
        if self.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE):
            require(self.size <= 65536)
        if self.type in (tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK):
            require(self.size <= 4096)
        return super()._proc_member(archive)

    def _proc_gnusparse_00(self, *args):
        raise ConfigError('configuration_deferred')

    def _proc_gnusparse_01(self, *args):
        raise ConfigError('configuration_deferred')

    def _proc_gnusparse_10(self, *args):
        raise ConfigError('configuration_deferred')


class ExpandedArchive:
    def __init__(self, decoder):
        self.decoder, self.count, self.end = decoder, 0, time.monotonic() + 180

    def read(self, size):
        require(time.monotonic() <= self.end)
        data = self.decoder.read(min(size, 65536))
        self.count += len(data)
        require(self.count <= MAX_EXPANSION and time.monotonic() <= self.end)
        return data


def payload(fd):
    result, seen, expanded, count = {}, set(), 0, 0
    os.lseek(fd, 0, os.SEEK_SET)
    with os.fdopen(os.dup(fd), 'rb') as file, gzip.GzipFile(fileobj=file) as decoder, \
            tarfile.open(fileobj=ExpandedArchive(decoder), mode='r|', tarinfo=BoundedTarInfo) as archive:
        for member in archive:
            name = member.name.removeprefix('./')
            if name in ('funded-host-config', 'funded-host-config/'):
                name = 'funded-host-config'
            count += 1
            require(count <= 250000 and len(name) <= 1024 and name not in seen
                    and not name.startswith('/') and all(part not in ('', '..', '.') for part in name.rstrip('/').split('/')))
            seen.add(name)
            # Full archives legitimately contain app symlinks. Never extract them;
            # only the protected component namespace requires regular bounded files.
            expanded += member.size
            require(expanded <= MAX_EXPANSION and not member.isdev() and not member.isfifo())
            if name == 'funded-host-config':
                require(member.isdir() and member.size == 0)
            elif name.startswith('funded-host-config/'):
                require(name in MEMBERS and member.isfile() and 0 < member.size <= 1048576)
                stream = archive.extractfile(member)
                require(stream is not None)
                data = stream.read(1048577)
                require(len(data) == member.size)
                result[name] = data
            elif member.issym() or member.islnk():
                require(name.startswith(('app/', 'runtime/', 'terminal-runtime/')))
    require(set(result) == set(MEMBERS))
    return result


def maintenance_lock(state):
    """Serialize installs, maintenance and restoration without blocking."""
    fd = os.open('resume.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                 0o600, dir_fd=state.fds[-1])
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
                and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def install(version, source, use_staged=False):
    require(os.geteuid() == 0)
    lib = Directory('/', ('usr', 'local', 'libexec'), create=True)
    units = Directory('/', ('etc', 'systemd', 'system'), create=True)
    state = Directory('/', ('var', 'lib', 'matrix-funded-host-config'), create=True)
    os.fchmod(state.fds[-1], 0o700)
    lock = maintenance = archive_fd = copy_fd = None
    names = []
    try:
        maintenance = maintenance_lock(state)
        lock = os.open('install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=state.fds[-1])
        require(os.fstat(lock).st_uid == 0 and stat.S_ISREG(os.fstat(lock).st_mode) and os.fstat(lock).st_nlink == 1)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not os.path.lexists('/var/lib/matrix-funded-host-config/install-pending.json'))
        # Crash remnants have no authority. Fail closed rather than retain an
        # unbounded archive set or accidentally overwrite rollback evidence.
        require(not any(name.startswith('.archive-') for name in os.listdir(state.fds[-1])))
        meta = validate_metadata(json_bytes(get('/system-bundles/releases/' + version + '.json')), version, source)
        try:
            receipt = json_bytes(state.read('receipt.json'))
            if receipt.get('version') == version and receipt.get('sourceSha') == source and receipt.get('archiveSha256') == meta['sha256']:
                require(digest(lib.read('matrix-funded-host-config.py')) == receipt['componentSha256']
                        and digest(units.read('matrix-funded-host-config.service')) == receipt['unitSha256'])
                return
        except FileNotFoundError:
            pass
        # A verified no-op above preserves pending evidence; any changing
        # install must wait until the exact prior restoration completes.
        require(not os.path.lexists('/var/lib/matrix-funded-host-config/resume.json'))
        if use_staged:
            archive_fd = os.open('/opt/matrix/staging/bundle-' + version + '.tar.gz',
                                 os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        required = meta['size'] * (1 if use_staged else 2) + 128 * 1024 ** 2
        space = os.fstatvfs(state.fds[-1])
        require(space.f_bavail * space.f_frsize >= required)
        for _ in range(1 if use_staged else 2):
            name = '.archive-' + secrets.token_hex(12)
            names.append(name)
            fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=state.fds[-1])
            if archive_fd is None:
                archive_fd = fd
            else:
                copy_fd = fd
        def store_chunk(chunk):
            offset = 0
            while offset < len(chunk):
                offset += os.write(archive_fd, chunk[offset:])
        if not use_staged:
            require(get_artifact(meta, version, store_chunk) == meta['size'])
        snapshot(archive_fd, copy_fd, meta)
        verified = payload(copy_fd)
        # Retain one protected prior generation for rollback; never staged imports.
        for anchor, name in ((lib, 'matrix-funded-host-config.py'), (units, 'matrix-funded-host-config.service'), (state, 'receipt.json')):
            try:
                state.write('previous-' + name, anchor.read(name), 0o600)
            except FileNotFoundError:
                state.write('previous-' + name, b'', 0o600)
        code, unit = (verified[name] for name in MEMBERS)
        state.write('install-pending.json', json.dumps({'version': version, 'sourceSha': source}).encode(), 0o600)
        lib.write('matrix-funded-host-config.py', code, 0o644)
        units.write('matrix-funded-host-config.service', unit, 0o644)
        receipt = {'version': version, 'sourceSha': source, 'archiveSha256': meta['sha256'],
                   'componentSha256': digest(code), 'unitSha256': digest(unit)}
        state.write('receipt.json', json.dumps(receipt, separators=(',', ':')).encode(), 0o600)
        os.unlink('install-pending.json', dir_fd=state.fds[-1])
        os.fsync(state.fds[-1])
    finally:
        try:
            for fd in (archive_fd, copy_fd):
                if fd is not None:
                    os.close(fd)
            for name in names:
                os.unlink(name, dir_fd=state.fds[-1])
        finally:
            for fd in (lock, maintenance):
                if fd is not None:
                    os.close(fd)
            lib.close()
            units.close()
            state.close()


def schedule(version, source, operation='apply', prior=None):
    """Only inlined explicit updater hook calls this; no remote command input."""
    import subprocess
    state = Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
    try:
        receipt = json_bytes(state.read('receipt.json'))
        require(receipt['version'] == version and receipt['sourceSha'] == source)
        require(operation in ('apply', 'rollback') and (operation == 'rollback') == (prior is not None))
        if operation == 'rollback':
            previous = json_bytes(state.read('previous-receipt.json'))
            require(previous['version'] == prior and prior != version)
            validate_metadata(json_bytes(get('/system-bundles/releases/' + prior + '.json')), prior, previous['sourceSha'])
        now = time.time()
        try:
            stale = json_bytes(state.read('invocation.json'))
            require(set(stale) == {'version', 'sourceSha', 'createdAt', 'expiresAt', 'kind', 'operation', 'priorVersion'}
                    and stale['version'] == version and stale['sourceSha'] == source and stale['kind'] == 'explicit-update'
                    and stale['operation'] in ('apply', 'rollback')
                    and type(stale['createdAt']) in (int, float) and type(stale['expiresAt']) in (int, float)
                    and stale['createdAt'] < stale['expiresAt'] <= now
                    and stale['expiresAt'] - stale['createdAt'] <= 30)
            state.verify()
            os.unlink('invocation.json', dir_fd=state.fds[-1])
            os.fsync(state.fds[-1])  # Expired unconsumed invocation never stopped work.
        except FileNotFoundError:
            pass
        # Exclusive admission: never overwrite a pending/unknown invocation.
        fd = os.open('invocation.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=state.fds[-1])
        try:
            data = json.dumps({'version': version, 'sourceSha': source, 'createdAt': now,
                               'expiresAt': now + 30, 'kind': 'explicit-update',
                               'operation': operation, 'priorVersion': prior}).encode()
            require(os.write(fd, data) == len(data))
            os.fsync(fd)
            os.fsync(state.fds[-1])
        finally:
            os.close(fd)
        result = subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], capture_output=True,
                                timeout=10, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        require(result.returncode == 0)
        result = subprocess.run(['/usr/bin/systemctl', 'start', '--no-block', 'matrix-funded-host-config.service'],
                                capture_output=True, timeout=10, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        require(result.returncode == 0)
    finally:
        state.close()

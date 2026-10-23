"""Build-inlined first-upgrade repair; never import an owner-writable program.

The reviewed updater is the inherited trust anchor, as for funded-host bootstrap.
Its build binds exact helper/runtime/unit digests to the committed release.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import re
import stat
import subprocess


def require(value):
    if not value:
        raise ValueError('Browser bootstrap deferred')


class Anchor:
    def __init__(self, root, parts, uid, create=False, harden=False, historical=False):
        self.parts, self.uid, self.fds, self.historical = parts, uid, [], historical
        try:
            self.fds.append(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
            self.verify()
            for index, part in enumerate(parts):
                if create:
                    try:
                        os.mkdir(part, 0o755, dir_fd=self.fds[-1])
                    except FileExistsError:
                        pass
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fds[-1])
                self.fds.append(fd)
                info = os.fstat(fd)
                require(info.st_uid == uid)
                # Historical provisioning grants the matrix group write access.
                # Pin and harden only root-owned OS containers, never owner data.
                prefix = '/'.join(parts[:index + 1])
                if harden and prefix in ('opt/matrix', 'opt/matrix/bin', 'opt/matrix/env') and info.st_mode & 0o020:
                    require(not info.st_mode & 0o002)
                    os.fchmod(fd, stat.S_IMODE(info.st_mode) & ~0o022)
                self.verify()
        except BaseException:
            self.close()
            raise

    def verify(self):
        for index, fd in enumerate(self.fds):
            info = os.fstat(fd)
            allowed = 0o020 if self.historical and '/'.join(self.parts[:index]) in ('opt/matrix', 'opt/matrix/env') else 0
            require(info.st_uid == self.uid and not info.st_mode & (0o022 & ~allowed))
            if index:
                actual = os.stat(self.parts[index - 1], dir_fd=self.fds[index - 1], follow_symlinks=False)
                require(stat.S_ISDIR(actual.st_mode) and (actual.st_dev, actual.st_ino) == (info.st_dev, info.st_ino))

    def read(self, name, limit=131072):
        self.verify()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fds[-1])
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == self.uid and info.st_nlink == 1
                    and not info.st_mode & 0o022 and info.st_size <= limit)
            data = bytearray()
            while len(data) <= limit:
                chunk = os.read(fd, min(65536, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            after = os.fstat(fd)
            require(len(data) == info.st_size and len(data) <= limit
                    and (info.st_mtime_ns, info.st_ctime_ns) == (after.st_mtime_ns, after.st_ctime_ns))
            self.verify()
            return bytes(data)
        finally:
            os.close(fd)

    def write(self, name, data, mode=0o644):
        self.verify()
        try:
            self.read(name, max(len(data), 131072))
        except FileNotFoundError:
            pass
        temporary = '.browser-' + secrets.token_hex(12)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fds[-1])
        try:
            with os.fdopen(fd, 'wb', closefd=False) as target:
                target.write(data)
                target.flush()
            os.fchmod(fd, mode)
            os.fsync(fd)
            self.verify()
            os.replace(temporary, name, src_dir_fd=self.fds[-1], dst_dir_fd=self.fds[-1])
            os.fsync(self.fds[-1])
        finally:
            os.close(fd)
            try:
                os.unlink(temporary, dir_fd=self.fds[-1])
            except FileNotFoundError:
                pass

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds = []


def reconcile(root=Path('/'), uid=0):
    anchors, lock = [], None
    def anchor(parts, **options):
        value = Anchor(root, tuple(parts.split('/')), uid, **options)
        anchors.append(value)
        return value
    try:
        # Pin/read root-owned identity before any chmod, mkdir or protected write.
        # The historical root:matrix containers may be group-writable here.
        identity_anchor = anchor('opt/matrix/env', historical=True)
        environment = identity_anchor.read('host.env').decode()
        values = {}
        for line in environment.splitlines():
            if line.startswith(('MATRIX_BROWSER_LAB=', 'MATRIX_MACHINE_ID=', 'MATRIX_HANDLE=', 'MATRIX_RUNTIME_SLOT=', 'MATRIX_CLERK_USER_ID=', 'MATRIX_USER_ID=')):
                key, value = line.split('=', 1)
                require(key not in values)
                values[key] = value.strip('"')
        if values.get('MATRIX_BROWSER_LAB') == 'false':
            return
        require(values.get('MATRIX_RUNTIME_SLOT') == 'primary'
                and re.fullmatch(r'[a-z][a-z0-9-]{0,62}', values.get('MATRIX_HANDLE', ''))
                and not values['MATRIX_HANDLE'].startswith(('pv-', 'pr-'))
                and re.fullmatch(r'user_[A-Za-z0-9]{1,128}', values.get('MATRIX_CLERK_USER_ID', ''))
                and values.get('MATRIX_USER_ID', values.get('MATRIX_CLERK_USER_ID')) == values.get('MATRIX_CLERK_USER_ID')
                and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', values.get('MATRIX_MACHINE_ID', '')))
        binding = hashlib.sha256(json.dumps({key: values[key] for key in ('MATRIX_MACHINE_ID', 'MATRIX_HANDLE', 'MATRIX_CLERK_USER_ID')}, sort_keys=True).encode()).hexdigest()
        # Recovery/rollback must settle before optional native mutation.
        if any(os.path.lexists(root / relative) for relative in ('opt/matrix/staging/update-phase', 'opt/matrix/app/.rollback-now')):
            return
        base = anchor('opt/matrix', historical=True)
        release_bytes = base.read('release.json')
        release = json.loads(release_bytes)
        require(release.get('version') == EXPECTED['version'] and release.get('gitCommit') == EXPECTED['gitCommit'])
        app = root / 'opt/matrix/app'
        require(not app.is_symlink() and app.is_dir())
        fd = os.open(app / 'BUNDLE_VERSION', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            require(stat.S_ISREG(os.fstat(fd).st_mode) and os.read(fd, 257).decode().strip() == EXPECTED['version'])
        finally:
            os.close(fd)
        base = anchor('opt/matrix', harden=True)
        require(base.read('release.json') == release_bytes)
        anchor('opt/matrix/env', harden=True)
        require(identity_anchor.read('host.env').decode() == environment)
        sources = anchor('opt/matrix/bin', harden=True)
        try:
            payload = {name: sources.read(name, 64 * 1024 * 1024) for name in EXPECTED['files']}
        except FileNotFoundError:
            return  # Legacy/incomplete bundle: never synthesize native setup.
        require(all(hashlib.sha256(data).hexdigest() == EXPECTED['files'][name] for name, data in payload.items()))
        units = anchor('etc/systemd/system')
        require(hashlib.sha256(units.read('matrix-browser-runtime.service')).hexdigest() == EXPECTED['unitSha256'])
        lib = anchor('usr/local/libexec', create=True)
        state = anchor('var/lib/matrix-browser-bootstrap', create=True)
        lock = os.open('bootstrap.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=state.fds[-1])
        info = os.fstat(lock)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1 and not info.st_mode & 0o077)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        helper = payload['matrix-browser-runtime.py']
        receipt = json.dumps({**EXPECTED, 'bindingSha256': binding}, sort_keys=True).encode()
        try:
            if state.read('receipt.json') == receipt and lib.read('matrix-browser-runtime.py') == helper:
                return
        except FileNotFoundError:
            pass
        lib.write('matrix-browser-runtime.py', helper)
        for command in (['daemon-reload'], ['enable', 'matrix-browser-runtime.service'],
                        ['start', '--no-block', 'matrix-browser-runtime.service']):
            subprocess.run(['/usr/bin/systemctl', *command], check=True, timeout=10,
                           capture_output=True, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        state.write('receipt.json', receipt, 0o600)
    finally:
        if lock is not None:
            os.close(lock)
        for value in reversed(anchors):
            value.close()


if __name__ == '__main__':
    try:
        require(os.geteuid() == 0)
        reconcile()
    except Exception:
        print('Browser bootstrap deferred', file=__import__('sys').stderr)
        raise SystemExit(1)

"""Bounded, manually launched isolated Main qualification desktop. No installation."""
import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

LIFETIME = 600
BWRAP = '/usr/bin/bwrap'
STARTUP_CODES = {'unsupported_option', 'missing_shared_library', 'sandbox_unavailable', 'socket_binding',
                 'display_lock', 'font_unavailable', 'xkb_unavailable', 'permission_denied', 'missing_runtime_file',
                 'viewer_authentication', 'resource_limit', 'invalid_executable', 'unclassified'}
STARTUP_PHASES = {'preflight', 'viewer_credentials', 'xvnc', 'isolation_receipt', 'desktop_apps', 'viewer_relay', 'running'}


class DesktopStartupError(ValueError):
    def __init__(self, phase, diagnostic=None):
        super().__init__('isolated_desktop_failed')
        self.phase = phase if isinstance(phase, str) and phase in STARTUP_PHASES else None
        self.diagnostic = None
        if isinstance(diagnostic, dict) and isinstance(diagnostic.get('service'), str) and diagnostic['service'] in {'xvnc', 'openbox', 'panel', 'chrome'} and isinstance(diagnostic.get('code'), str) and diagnostic['code'] in STARTUP_CODES:
            safe = {'service': diagnostic['service'], 'code': diagnostic['code']}
            for key, lower, upper in (('exit_code', -255, 255), ('stderr_bytes', 0, 65536), ('errno', 1, 4095)):
                value = diagnostic.get(key)
                if type(value) is int and lower <= value <= upper:
                    safe[key] = value
            if type(diagnostic.get('truncated')) is bool:
                safe['truncated'] = diagnostic['truncated']
            self.diagnostic = safe


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('private directory required')
    # Reject symlinks in every existing ancestor as well as the leaf.
    if path != path.resolve():
        raise ValueError('canonical path required')


def prepare(bundle, state):
    b, s = Path(bundle), Path(state)
    if not b.is_absolute() or not s.is_absolute():
        raise ValueError('absolute paths required')
    private_directory(s)
    if b != b.resolve() or not b.is_dir() or b == s or b in s.parents or s in b.parents:
        raise ValueError('separate canonical bundle required')
    # Host-only node_modules may contain SDK symlinks; neither it nor its targets are mounted.
    for subtree in ('code', 'deps'):
        root = b / subtree
        if root.is_symlink():
            raise ValueError('unreviewed bundle subtree')
        for entry in root.rglob('*'):
            info = entry.lstat()
            if info.st_uid != os.getuid() or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or info.st_mode & 0o022:
                raise ValueError('unreviewed bundle entry')
    desktop = s / 'desktop'
    desktop.mkdir(mode=0o700, exist_ok=True)
    private_directory(desktop)
    proxy = (desktop / 'proxy.sock').lstat()
    if not stat.S_ISSOCK(proxy.st_mode) or proxy.st_uid != os.getuid():
        raise ValueError('guardian proxy required')
    for name in ('x11', 'home', 'run', 'config', 'relay'):
        path = desktop / name
        path.mkdir(mode=0o700, exist_ok=True)
        private_directory(path)
    if list((desktop / 'x11').iterdir()) or list((desktop / 'home').iterdir()):
        raise ValueError('fresh synthetic desktop required')
    config = {
        'passwd': 'qualification:x:999:999:Qualification:/home/qualification:/bin/bash\n',
        'group': 'qualification:x:999:\n',
        'hosts': '127.0.0.1 localhost qualification\n::1 localhost\n',
        'nsswitch.conf': 'passwd: files\ngroup: files\nhosts: files dns\n',
        'machine-id': '8f60890930b049a3a6d533f05b12e333\n',
    }
    for name, value in config.items():
        with (desktop / 'config' / name).open('x') as out:
            out.write(value)
    return desktop


def build_outer(bundle, desktop, namespaces, main_x7):
    args = [BWRAP, '--die-with-parent', '--new-session', '--unshare-user', '--uid', '0', '--gid', '0',
            '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
            '--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_SETFCAP', '--clearenv',
            '--ro-bind', '/usr', '/usr']
    for name in ('bin', 'sbin', 'lib', 'lib64'):
        args += ['--symlink', 'usr/' + name, '/' + name]
    args += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
             '--tmpfs', '/home', '--dir', '/etc', '--dir', '/opt', '--dir', '/opt/google',
             '--ro-bind', '/opt/google/chrome', '/opt/google/chrome',
             '--dir', '/qual', '--ro-bind', bundle + '/code', '/qual/code',
             '--ro-bind', bundle + '/deps', '/qual/deps', '--tmpfs', '/state',
             '--ro-bind', desktop + '/proxy.sock', '/state/proxy.sock',
             '--ro-bind', desktop + '/viewer-bootstrap', '/state/viewer-bootstrap',
             '--bind', desktop + '/relay', '/state/relay',
             '--bind', desktop + '/x11', '/tmp/.X11-unix',
             '--bind', desktop + '/home', '/home/qualification',
             '--bind', desktop + '/run', '/run/user/999']
    for name in ('passwd', 'group', 'hosts', 'nsswitch.conf', 'machine-id'):
        args += ['--ro-bind', desktop + '/config/' + name, '/etc/' + name]
    for name in ('fonts', 'ssl/certs', 'ld.so.cache', 'os-release'):
        source = '/etc/' + name
        if Path(source).exists():
            args += ['--ro-bind', source, source]
    if Path('/opt/matrix/runtime/node').is_dir():
        args += ['--ro-bind', '/opt/matrix/runtime/node', '/opt/matrix/runtime/node']
    for name, value in {'HOME': '/home/qualification', 'USER': 'qualification', 'LOGNAME': 'qualification',
                        'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'DISPLAY': ':7',
                        'XDG_RUNTIME_DIR': '/run/user/999', 'XDG_CONFIG_HOME': '/home/qualification/.config'}.items():
        args += ['--setenv', name, value]
    return args + ['--chdir', '/home/qualification', '--', '/usr/bin/python3', '-I',
                   '/qual/code/isolation/sandbox.py', '--inside-setup',
                   json.dumps({'host_namespaces': namespaces, 'main_x7': main_x7}, separators=(',', ':'))]


def build_inner(metadata):
    args = [BWRAP, '--die-with-parent', '--new-session', '--unshare-user', '--uid', '999', '--gid', '999',
            '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL',
            '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev']
    for path in ('/state/relay', '/tmp', '/run', '/home/qualification'):
        args += ['--bind', path, path]
    args += ['--', '/usr/bin/python3', '-I', '/qual/code/isolation/desktop.py', metadata]
    return args


def inside_setup(metadata):
    # These capabilities exist only in the temporary user/network namespace.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        data = struct.pack('16sH14x', b'lo', 0)
        flags = struct.unpack('16sH14x', fcntl.ioctl(sock, 0x8913, data))[1]
        fcntl.ioctl(sock, 0x8914, struct.pack('16sH14x', b'lo', flags | 1))
    os.execv(BWRAP, build_inner(metadata))


def stop_group(child):
    for sig, timeout in ((signal.SIGTERM, 0.5), (signal.SIGKILL, 0.5)):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            break
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            continue
        # Kill residual descendants even if the group leader exited first.
        if sig == signal.SIGTERM:
            continue
    child.wait(timeout=1)


def cleanup_desktop_files(desktop):
    # Desktop programs can replace any child directory with a symlink. Anchor
    # every lookup to an opened directory and never follow those links on host.
    for name in ('relay/viewer.sock', 'home/.vnc/qualification.passwd'):
        current = os.open(desktop, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parts = name.split('/')
            for part in parts[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                os.close(current)
                current = next_fd
            os.unlink(parts[-1], dir_fd=current)
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                raise
        finally:
            os.close(current)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle')
    parser.add_argument('--state')
    parser.add_argument('--inside-setup')
    args = parser.parse_args()
    if args.inside_setup:
        inside_setup(args.inside_setup)
        return
    if sys.platform != 'linux' or os.getuid() != 999:
        raise ValueError('qualified Linux user required')
    desktop = prepare(args.bundle, args.state)
    password = os.environ.pop('MATRIX_QUAL_VIEWER_PASSWORD', '')
    if not 16 <= len(password) <= 128 or not password.isascii() or not password.isalnum():
        raise ValueError('fresh alphanumeric viewer password required')
    secret = desktop / 'viewer-bootstrap'
    namespaces = {key: os.readlink('/proc/self/ns/' + key) for key in ('net', 'mnt', 'pid')}
    original = Path('/tmp/.X11-unix/X7').stat()
    command = build_outer(args.bundle, str(desktop), namespaces, [original.st_dev, original.st_ino])
    fd = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write(password)
    del password
    try:
        child = subprocess.Popen(command, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
    except OSError:
        secret.unlink(missing_ok=True)
        raise
    stopped = False
    def halt(_signum, _frame):
        nonlocal stopped
        stopped = True
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, halt)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    started, ready, pending = time.monotonic(), False, b''
    try:
        while not stopped and child.poll() is None and time.monotonic() - started < LIFETIME:
            if not ready and time.monotonic() - started > 35:
                raise ValueError('desktop readiness timeout')
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                pending += chunk
                if len(pending) > 8192:
                    raise ValueError('desktop output exceeded')
                if b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    result = json.loads(line)
                    if not ready and result.get('ready') is False:
                        raise DesktopStartupError(result.get('phase'), result.get('diagnostic'))
                    if ready or result.get('ready') is not True or not isinstance(result.get('receipt'), dict):
                        raise ValueError('invalid readiness')
                    print(json.dumps(result, separators=(',', ':')), flush=True)
                    ready = True
                    secret.unlink(missing_ok=True)
        if not stopped and time.monotonic() - started < LIFETIME:
            raise ValueError('desktop terminated')
    finally:
        selector.close()
        stop_group(child)
        secret.unlink(missing_ok=True)
        # Do not remove guardian-owned proxy or retained synthetic QA artifacts.
        cleanup_desktop_files(desktop)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        failure = {'ready': False, 'error': 'isolated_desktop_failed'}
        if isinstance(error, DesktopStartupError) and error.phase:
            failure['phase'] = error.phase
            if error.diagnostic is not None:
                failure['diagnostic'] = error.diagnostic
        print(json.dumps(failure), flush=True)
        sys.exit(1)

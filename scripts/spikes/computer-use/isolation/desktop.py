"""Synthetic desktop inside nested Bubblewrap. Never execute on the host."""
import errno
import json
import os
from pathlib import Path
import select
import signal
import socket
import stat
import subprocess
import sys
import threading
import time

# The Xvnc alias traverses /etc/alternatives, intentionally absent in this sandbox.
XVNC_PROGRAM = '/usr/bin/Xkasmvnc'
MAX_CONNECTIONS = 8
MAX_BYTES = 64 * 1024 * 1024
MAX_SECONDS = 600
PHASE = 'preflight'
STARTUP_DIAGNOSTIC = None
STARTUP_FAILURE_DIAGNOSTIC = None
FIRST_REQUIRED_FAILURE = None


def classify_startup(data):
    """Only fixed categories escape the namespace; program text is never returned."""
    text = data.lower()
    rules = (
        ('unsupported_option', (b'unrecognized option', b'unknown option', b'unknown parameter')),
        ('missing_shared_library', (b'error while loading shared libraries', b'cannot open shared object file')),
        ('sandbox_unavailable', (b'no usable sandbox', b'failed to move to new namespace', b'zygote_host_impl_linux')),
        ('socket_binding', (b'cannot establish any listening sockets', b'failed to establish all listening sockets', b'address already in use', b'cannot bind')),
        ('display_lock', (b'server is already active for display', b'could not create lock file')),
        ('font_unavailable', (b'could not open default font', b'could not init font path')),
        ('xkb_unavailable', (b'failed to compile keymap', b'xkbcomp reports', b'failed to activate virtual core keyboard')),
        ('permission_denied', (b'permission denied', b'operation not permitted', b'read-only file system')),
        ('missing_runtime_file', (b'no such file or directory',)),
        ('viewer_authentication', (b'no password configured', b'failed to read password', b'password file is empty')),
    )
    return next((code for code, markers in rules if any(marker in text for marker in markers)), 'unclassified')


class DesktopProgramError(OSError):
    def __init__(self, error):
        super().__init__('desktop_program_launch_failed')
        codes = {
            errno.ENOENT: 'missing_runtime_file', errno.ENOTDIR: 'missing_runtime_file',
            errno.EACCES: 'permission_denied', errno.EPERM: 'permission_denied',
            errno.EAGAIN: 'resource_limit', errno.ENOMEM: 'resource_limit',
            errno.EMFILE: 'resource_limit', errno.ENFILE: 'resource_limit',
            errno.ENOEXEC: 'invalid_executable', getattr(errno, 'ELIBBAD', errno.ENOEXEC): 'invalid_executable',
        }
        self.diagnostic = {'service': 'xvnc', 'code': codes.get(error.errno, 'unclassified')}
        if type(error.errno) is int and 1 <= error.errno <= 4095:
            self.diagnostic['errno'] = error.errno


def spawn_desktop(argv):
    try:
        return subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE if argv[0] == XVNC_PROGRAM else subprocess.DEVNULL,
                                env=dict(os.environ))
    except OSError as error:
        if argv[0] == XVNC_PROGRAM:
            raise DesktopProgramError(error) from None
        raise


class RequiredChildError(ValueError):
    def __init__(self, service, code):
        super().__init__('required_desktop_program_exited')
        self.diagnostic = {'service': service, 'code': 'unclassified', 'exit_code': code}


def require_running(required):
    global FIRST_REQUIRED_FAILURE
    for service, child in required:
        code = child.poll()
        if code is not None:
            # Freeze the first observed failure before termination changes other statuses.
            error = RequiredChildError(service, code)
            if FIRST_REQUIRED_FAILURE is None:
                FIRST_REQUIRED_FAILURE = dict(error.diagnostic)
            raise error


class StartupDiagnostic:
    """Drain stderr without blocking; keep at most 8 KiB until startup completes."""
    def __init__(self, child):
        self.child, self.data, self.count, self.active = child, b'', 0, True
        self.read_failed = False
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.drain, daemon=True)
        self.thread.start()

    def drain(self):
        try:
            while True:
                chunk = os.read(self.child.stderr.fileno(), 4096)
                if not chunk:
                    break
                with self.lock:
                    if self.active:
                        self.data = (self.data + chunk)[-8192:]
                        self.count = min(65536, self.count + len(chunk))
        except OSError:
            self.read_failed = True
        finally:
            self.child.stderr.close()

    def discard(self):
        with self.lock:
            self.active, self.data = False, b''

    def snapshot(self):
        self.thread.join(timeout=0.3)
        with self.lock:
            if not self.active:
                return None
            result = {'service': 'xvnc', 'code': classify_startup(self.data),
                      'stderr_bytes': self.count, 'truncated': self.count > 8192}
            if self.child.returncode is not None:
                result['exit_code'] = self.child.returncode
            self.data = b''
            return result



class Relay:
    """Two bounded routes; no route accepts a caller-supplied destination."""
    def __init__(self, stop):
        self.stop = stop
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self.listeners = []
        self.threads = []

    def start(self, family, address, target_family, target):
        listener = socket.socket(family, socket.SOCK_STREAM)
        listener.settimeout(0.2)
        listener.bind(address)
        if family == socket.AF_UNIX:
            os.chmod(address, 0o600)
        listener.listen(MAX_CONNECTIONS)
        self.listeners.append(listener)
        thread = threading.Thread(target=self.accept, args=(listener, target_family, target), daemon=True)
        thread.start()
        self.threads.append(thread)

    def accept(self, listener, family, target):
        while not self.stop.is_set():
            try:
                client, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                self.stop.set()
                return
            if not self.slots.acquire(blocking=False):
                client.close()
                continue
            threading.Thread(target=self.forward, args=(client, family, target), daemon=True).start()

    def forward(self, client, family, target):
        peer = socket.socket(family, socket.SOCK_STREAM)
        try:
            peer.settimeout(2)
            peer.connect(target)
            client.settimeout(1)
            peer.settimeout(1)
            count, touched, started = 0, time.monotonic(), time.monotonic()
            while not self.stop.is_set() and count < MAX_BYTES and time.monotonic() - started < MAX_SECONDS:
                readable, _, _ = select.select([client, peer], [], [], 0.2)
                if time.monotonic() - touched > 30:
                    break
                for source in readable:
                    data = source.recv(min(65536, MAX_BYTES - count))
                    if not data:
                        return
                    count += len(data)
                    (peer if source is client else client).sendall(data)
                    touched = time.monotonic()
        except (OSError, ValueError):
            # Closed/expired transport is terminal; no reconnect/replay.
            return
        finally:
            client.close()
            peer.close()
            self.slots.release()

    def close(self):
        self.stop.set()
        for thread in self.threads:
            thread.join(timeout=0.3)
        for listener in self.listeners:
            listener.close()


def receipt(metadata):
    cap = next(line.split()[1] for line in Path('/proc/self/status').read_text().splitlines()
               if line.startswith('CapEff:'))
    namespaces = {key: os.readlink('/proc/self/ns/' + key) for key in ('net', 'mnt', 'pid')}
    if os.getuid() != 999 or os.getgid() != 999 or int(cap, 16) != 0:
        raise ValueError('unprivileged desktop required')
    if any(namespaces[key] == metadata['host_namespaces'][key] for key in namespaces):
        raise ValueError('private namespaces required')
    if Path('/home/matrix').exists() or Path('/state/host').exists():
        raise ValueError('host state visible')
    info = Path('/tmp/.X11-unix/X7').stat()
    if not stat.S_ISSOCK(info.st_mode) or [info.st_dev, info.st_ino] == metadata['main_x7']:
        raise ValueError('private display required')
    return {'uid': os.getuid(), 'gid': os.getgid(), 'cap_eff': cap,
            'net_namespace': namespaces['net'], 'mount_namespace': namespaces['mnt'],
            'pid_namespace': namespaces['pid'], 'host_home_visible': False, 'main_x7_visible': False,
            'x11_dev': info.st_dev, 'x11_ino': info.st_ino}


def desktop_config():
    home = Path('/home/qualification')
    config = home / '.config'
    (config / 'openbox').mkdir(parents=True, exist_ok=True)
    (config / 'openbox/menu.xml').write_text('''<?xml version="1.0"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu"><menu id="root-menu" label="Qualification">
<item label="Terminal"><action name="Execute"><command>xfce4-terminal --disable-server</command></action></item>
</menu></openbox_menu>''')
    (config / 'openbox/rc.xml').write_text('''<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc"><applications/>
<mouse><context name="Root"><mousebind button="Right" action="Press"><action name="ShowMenu"><menu>root-menu</menu></action></mousebind></context></mouse>
<menu><file>menu.xml</file></menu></openbox_config>''')
    (config / 'tint2').mkdir(exist_ok=True)
    launcher = config / 'qualification-terminal.desktop'
    launcher.write_text('[Desktop Entry]\nType=Application\nName=Terminal\nExec=xfce4-terminal --disable-server\nIcon=utilities-terminal\nTerminal=false\n')
    (config / 'tint2/tint2rc').write_text('''panel_items = LT
panel_position = bottom center horizontal
panel_size = 100% 48
panel_layer = top
panel_background_id = 0
launcher_icon_size = 32
launcher_item_app = /home/qualification/.config/qualification-terminal.desktop
task_text = 1
task_icon = 1
task_maximum_size = 240 40
''')
    (home / '.vnc').mkdir(mode=0o700)


def main():
    global PHASE, STARTUP_DIAGNOSTIC, STARTUP_FAILURE_DIAGNOSTIC
    if len(sys.argv) == 2:
        # One private DBus session for every application; never inherit the host bus.
        os.execve('/usr/bin/dbus-run-session', ['/usr/bin/dbus-run-session', '--', '/usr/bin/python3', '-I',
                  '/qual/code/isolation/desktop.py', '--session', sys.argv[1]], dict(os.environ))
    if len(sys.argv) != 3 or sys.argv[1] != '--session':
        raise ValueError('invalid isolated launch')
    metadata = json.loads(sys.argv[2])
    # Check isolation before reading the fresh test-only viewer secret or starting GUI programs.
    initial_cap = next(line.split()[1] for line in Path('/proc/self/status').read_text().splitlines()
                       if line.startswith('CapEff:'))
    if os.getuid() != 999 or os.getgid() != 999 or int(initial_cap, 16) != 0 or Path('/home/matrix').exists() or Path('/state/host').exists():
        raise ValueError('isolation required')
    if os.readlink('/proc/self/ns/net') == metadata['host_namespaces']['net']:
        raise ValueError('private network required')
    PHASE = 'viewer_credentials'
    desktop_config()
    bootstrap = Path('/state/viewer-bootstrap')
    password = bootstrap.read_text()
    try:
        passwd = subprocess.run(['/usr/bin/kasmvncpasswd', '-u', 'matrix-qualification', '-r', '-w',
                                 '/home/qualification/.vnc/qualification.passwd'],
                                input=password + '\n' + password + '\n', text=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    finally:
        del password
    if passwd.returncode:
        raise ValueError('viewer credential initialization failed')
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda _signum, _frame: stop.set())
    relay = Relay(stop)
    children, required = [], []
    def launch(argv, service):
        global STARTUP_DIAGNOSTIC
        diagnose = argv[0] == XVNC_PROGRAM
        child = spawn_desktop(argv)
        if diagnose:
            STARTUP_DIAGNOSTIC = StartupDiagnostic(child)
        children.append(child)
        required.append((service, child))
        return child
    started = time.monotonic()
    try:
        relay.start(socket.AF_INET, ('127.0.0.1', 3128), socket.AF_UNIX, '/state/proxy.sock')
        PHASE = 'xvnc'
        launch([XVNC_PROGRAM, ':7', '-interface', '127.0.0.1', '-websocketPort', '6901', '-sslOnly', '0',
                '-AllowOverride', 'AcceptPointerEvents,AcceptKeyEvents', '-KasmPasswordFile',
                '/home/qualification/.vnc/qualification.passwd', '-SecurityTypes', 'None',
                '-httpd', '/usr/share/kasmvnc/www', '-geometry', '1440x900', '-depth', '24',
                '-nolisten', 'tcp', '-ac', '-AcceptCutText', '0', '-SendCutText', '0', '-SendPrimary', '0', '-SetPrimary', '0'], 'xvnc')
        while not Path('/tmp/.X11-unix/X7').exists():
            require_running(required)
            if time.monotonic() - started > 10 or stop.is_set():
                raise ValueError('display startup failed')
            stop.wait(0.05)
        # Complete capability/namespace/socket checks before the browser can receive pixels/input.
        PHASE = 'isolation_receipt'
        result = receipt(metadata)
        PHASE = 'desktop_apps'
        launch(['/usr/bin/openbox', '--config-file', '/home/qualification/.config/openbox/rc.xml'], 'openbox')
        launch(['/usr/bin/tint2', '-c', '/home/qualification/.config/tint2/tint2rc'], 'panel')
        launch(['/opt/google/chrome/chrome', '--user-data-dir=/home/qualification/chrome', '--no-first-run',
                '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-background-networking',
                '--disable-component-update', '--disable-sync', '--proxy-server=http://127.0.0.1:3128',
                '--proxy-bypass-list=<-loopback>', '--window-size=1280,780', '--window-position=40,30', 'about:blank'], 'chrome')
        search_env = dict(os.environ, LD_LIBRARY_PATH='/qual/deps/root/usr/lib/x86_64-linux-gnu')
        while True:
            require_running(required)
            if stop.is_set() or time.monotonic() - started > 28:
                raise ValueError('desktop application startup failed')
            found = subprocess.run(['/qual/deps/root/usr/bin/xdotool', 'search', '--onlyvisible', '--class', '[Cc]hrome'],
                                   env=search_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1)
            if found.returncode == 0:
                break
            stop.wait(0.1)
        PHASE = 'viewer_relay'
        relay.start(socket.AF_UNIX, '/state/relay/viewer.sock', socket.AF_INET, ('127.0.0.1', 6901))
        data = json.dumps(result, separators=(',', ':'))
        print('{"ready":true,"receipt":' + data + '}', flush=True)
        PHASE = 'running'
        STARTUP_DIAGNOSTIC.discard()
        while not stop.wait(0.1) and time.monotonic() - started < MAX_SECONDS:
            require_running(required)
    finally:
        # Capture startup metadata before cleanup sends TERM/KILL to healthy children.
        if STARTUP_DIAGNOSTIC is not None:
            STARTUP_FAILURE_DIAGNOSTIC = STARTUP_DIAGNOSTIC.snapshot()
        relay.close()
        for child in children:
            if child.poll() is None:
                child.terminate()
        deadline = time.monotonic() + 0.5
        for child in children:
            try:
                child.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()
        for child in children:
            child.wait(timeout=0.5)


def failure_diagnostic(error):
    if FIRST_REQUIRED_FAILURE is not None:
        if (FIRST_REQUIRED_FAILURE['service'] == 'xvnc' and
                STARTUP_FAILURE_DIAGNOSTIC is not None and
                STARTUP_FAILURE_DIAGNOSTIC['service'] == 'xvnc'):
            # Keep pre-cleanup attribution/exit, adding only that same service's
            # bounded diagnostic category; another child's failure stays intact.
            return {**STARTUP_FAILURE_DIAGNOSTIC, **FIRST_REQUIRED_FAILURE,
                    'code': STARTUP_FAILURE_DIAGNOSTIC['code']}
        return FIRST_REQUIRED_FAILURE
    if isinstance(error, (DesktopProgramError, RequiredChildError)):
        return error.diagnostic
    return STARTUP_FAILURE_DIAGNOSTIC


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        failure = {'ready': False, 'error': 'desktop_start_failed', 'phase': PHASE}
        diagnostic = failure_diagnostic(error)
        if diagnostic is not None:
            failure['diagnostic'] = diagnostic
        print(json.dumps(failure), flush=True)
        sys.exit(1)

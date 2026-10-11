"""Root-controlled single-use lease, shared flock and owned cancellation lifecycle."""
import fcntl
import os
from pathlib import Path
import signal
import stat
import select
import subprocess
import time
from lease_contract import validate_envelope
from lease_io import ControlPipe
from lease_process import OwnedProcess
from lease_protocol import LeaseProtocol
from lease_store import LeaseStore


class LeaseManager:
    def __init__(self, envelope, config, root, command, *, cleanup, verify, preflight=lambda: True,
                 pipe=None, protocol=None):
        self.envelope = validate_envelope(envelope, config)
        self.root = Path(root)
        self.store = LeaseStore(self.root / 'leases')
        self.protocol = protocol or LeaseProtocol(envelope)
        self.pipe = pipe or ControlPipe()
        self.command = command
        self.cleanup = cleanup
        self.verify = verify
        self.preflight = preflight
        self.child = None
        self.signalled = False

    def _tick(self, queue=False):
        records = self.pipe.poll()
        if self.signalled or self.pipe.eof or self.store.is_cancelled(self.protocol.lease):
            raise InterruptedError('Lease revoked')
        for value in records:
            if queue:
                raise ValueError('Grant before lock')
            self.protocol.accept(value)
        if not queue and self.protocol.expired():
            raise InterruptedError('Lease renewal expired')

    def _acquire(self, fd):
        deadline = time.monotonic() + 1800
        while True:
            self._tick(queue=True)
            if not self.store.is_first(self.protocol.lease):
                if time.monotonic() >= deadline:
                    raise TimeoutError('Queue deadline')
                continue
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Queue deadline')

    def _execute(self):
        if (self.root / 'cleanup.blocked').exists() or not self.preflight():
            raise RuntimeError('Previous owned cleanup unresolved')
        self.pipe.emit(self.protocol.locked())
        while not self.protocol.running:
            self._tick()
        self._tick()
        # No capability or controller environment enters the owned child.
        log_path = self.root / (self.protocol.lease + '.log')
        fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as log:
            self.child = OwnedProcess(self.command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'})
            self.pipe.emit(self.protocol.record('running'))
            deadline = time.monotonic() + 1800
            retained = 0
            eof = False
            while self.child.process.poll() is None or not eof:
                self._tick()
                if select.select([self.child.process.stdout], [], [], 0)[0]:
                    data = os.read(self.child.process.stdout.fileno(), 65536)
                    eof = not data
                    retained += len(data)
                    if retained > 20 * 1024 * 1024:
                        raise ValueError('Owned output exceeds bound')
                    log.write(data)
                if time.monotonic() >= deadline:
                    raise TimeoutError('Execution deadline')
                if self.protocol.pending is None and self.protocol.now() >= self.protocol.next_renewal:
                    self.pipe.emit(self.protocol.renewal())
            self._tick()
            if self.child.process.returncode:
                raise RuntimeError('Owned execution failed')

    def _cleanup_owned(self):
        def cleanup():
            try:
                return self.cleanup() is True
            except Exception as error:
                print('Owned cleanup failed: ' + type(error).__name__, file=__import__('sys').stderr)
                return False
        cleaned = cleanup() # Kill owned container CPU before stopping its wrapper.
        if self.child is not None:
            stopped = True
            try:
                self.child.cancel(grace=2)
            except Exception as error:
                print('Owned process cleanup failed: ' + type(error).__name__, file=__import__('sys').stderr)
                stopped = False
            finally:
                self.child.process.stdout.close()
            # A create/start RPC may have been in flight at the first cleanup.
            # Recheck only this lease after all owned wrapper processes exit.
            cleaned = cleanup() and stopped and cleaned
        return cleaned

    def run(self):
        fd = None
        reserved = False
        acquired = False
        status, kind, reason = 70, 'failed', 'execution_failed'
        previous = {}
        receipt = None
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            previous[sig] = signal.signal(sig, lambda *_: setattr(self, 'signalled', True))
        try:
            self.store.reserve(self.envelope)
            reserved = True
            self.pipe.emit(self.protocol.record('queued'))
            fd = os.open(self.root / 'benchmark.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise ValueError('Invalid shared lock')
            self._acquire(fd)
            acquired = True
            self._execute()
            status, kind, reason = 0, 'completed', None
        except InterruptedError:
            status, kind, reason = 75, 'cancelled', 'lease_revoked'
        except (ValueError, RuntimeError, TimeoutError, OSError) as error:
            # Never print an envelope, capability, raw candidate text or private path.
            print('Lease manager rejected operation: ' + type(error).__name__, file=__import__('sys').stderr)
        finally:
            try:
                if acquired:
                    cleaned = self._cleanup_owned()
                    if not cleaned:
                        status, kind, reason = 70, 'failed', 'cleanup_failed'
                        blocked = os.open(self.root / 'cleanup.blocked', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                        os.close(blocked)
                    elif status == 0:
                        self._tick()
                        receipt = self.verify()
                        self._tick()
                        if not isinstance(receipt, dict) or receipt.get('qualified') is not True:
                            raise ValueError('Evidence rejected')
                if reserved:
                    self.store.complete(self.protocol.lease)
            except Exception as error:
                print('Lease completion failed: ' + type(error).__name__, file=__import__('sys').stderr)
                status, kind, reason = 70, 'failed', 'evidence_failed'
            finally:
                # Removal/reaping and root verification finish before CPU admission lock release.
                if fd is not None:
                    os.close(fd)
                self.protocol.close()
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
            fields = {'status': status}
            if receipt is not None and status == 0:
                fields['receipt'] = receipt
            if reason:
                fields['reason'] = reason
            try:
                self.pipe.emit(self.protocol.record(kind, **fields))
            except (OSError, ValueError, TimeoutError) as error:
                print('Lease terminal pipe failed: ' + type(error).__name__, file=__import__('sys').stderr)
                status = 70
        return status

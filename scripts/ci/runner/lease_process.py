"""Cancellation of a process/session allocated by this manager, never caller PID."""
import os
import signal
import subprocess
import time


class OwnedProcess:
    def __init__(self, command, **kwargs):
        self.process = subprocess.Popen(command, start_new_session=True, stdin=subprocess.DEVNULL,
            close_fds=True, **kwargs)
        self.pid = self.process.pid
        self.identity = self._identity()

    def _identity(self):
        # Linux /proc start ticks prevent signalling a recycled session leader.
        try:
            with open('/proc/' + str(self.pid) + '/stat') as file:
                stat = file.read(4097)
            if len(stat) > 4096:
                raise ValueError('Process identity exceeds bound')
            return stat.rsplit(')', 1)[1].split()[19]
        except FileNotFoundError:
            return None # macOS or an already-exited leader; no caller PID accepted.

    def _signal(self, value):
        actual = self._identity()
        if self.identity is not None and actual is not None and actual != self.identity:
            raise RuntimeError('Owned process identity changed; refusing signal')
        try:
            os.killpg(self.pid, value)
        except ProcessLookupError:
            return

    def cancel(self, grace=5):
        self._signal(signal.SIGTERM)
        deadline = time.monotonic() + min(max(grace, 0), 5)
        while self.process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        # Leader exit alone does not prove that all session descendants exited.
        self._signal(signal.SIGKILL)
        self.process.wait(timeout=5)

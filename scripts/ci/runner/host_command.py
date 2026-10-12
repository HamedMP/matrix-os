"""Bounded pipe-only root commands; no output limit applied to Git object files."""
import os
import selectors
import signal
import subprocess
import time


def command(args, *, data=None, timeout=30, cap=1024 * 1024, session=True):
    if data is not None and len(data) > 2 * 1024 * 1024:
        raise ValueError('Command input exceeds bound')
    process = subprocess.Popen(args, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=session, close_fds=True,
        env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
             'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'})
    deadline = time.monotonic() + timeout
    buffers = [bytearray(), bytearray()]
    total = 0
    pending = memoryview(data or b'')
    previous = {}
    def interrupted(*_):
        raise InterruptedError('Owned command cancelled')
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        previous[sig] = signal.signal(sig, interrupted)
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, 0)
            selector.register(process.stderr, selectors.EVENT_READ, 1)
            if process.stdin is not None:
                if pending:
                    os.set_blocking(process.stdin.fileno(), False)
                    selector.register(process.stdin, selectors.EVENT_WRITE, 2)
                else:
                    process.stdin.close()
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Owned command deadline')
                for key, _ in selector.select(min(remaining, .1)):
                    if key.data == 2:
                        try:
                            pending = pending[os.write(key.fileobj.fileno(), pending[:4096]):]
                        except BlockingIOError:
                            continue
                        if not pending:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                    else:
                        part = os.read(key.fileobj.fileno(), min(65536, cap - total + 1))
                        if not part:
                            selector.unregister(key.fileobj)
                            continue
                        total += len(part)
                        if total > cap:
                            raise ValueError('Owned command output exceeds bound')
                        buffers[key.data].extend(part)
            process.wait(timeout=max(.001, deadline - time.monotonic()))
        return subprocess.CompletedProcess(args, process.returncode, bytes(buffers[0]), bytes(buffers[1]))
    finally:
        try:
            # Reap own session even when the leader exits before descendants.
            try:
                if session:
                    os.killpg(process.pid, signal.SIGKILL)
                elif process.poll() is None:
                    process.kill()
            except ProcessLookupError:
                pass # Expected already-exited owned session.
            process.wait(timeout=5)
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
            for sig, handler in previous.items():
                signal.signal(sig, handler)


def host_command(args, **kwargs):
    # Docker/iptables clients remain in the root wrapper's owned session. Remote
    # cancellation kills the entire wrapper group, including in-flight clients.
    return command(args, session=False, **kwargs)

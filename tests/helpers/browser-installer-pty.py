"""Run an argv under a real controlling terminal, with bounded capture/cleanup."""
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import time

argv = sys.argv[1:]
heartbeat = None
if argv[0] == '--heartbeat':
    heartbeat = Path(argv[1])
    argv = argv[2:]
result_reader, result_writer = os.pipe()
pid, master = pty.fork()
if pid == 0:
    os.close(result_reader)
    # Stay alive as the foreground session leader: exec'ing timeout here would
    # conceal the background-process-group defect the installer must avoid.
    signal.signal(signal.SIGTTOU, signal.SIG_DFL)
    command = subprocess.run(argv)
    result = {'exitCode': command.returncode}
    if heartbeat:
        # Observe before this session leader exits: its exit can SIGHUP a
        # foreground orphan and conceal an incorrectly weakened group timeout.
        result['heartbeatBefore'] = heartbeat.read_text()
        time.sleep(0.3)
        result['heartbeatAfter'] = heartbeat.read_text()
    os.write(result_writer, json.dumps(result).encode())
    os.close(result_writer)
    os._exit(0)

os.close(result_writer)
output = bytearray()
deadline = time.monotonic() + 8
try:
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(master, 4096)
        except OSError as error:
            if error.errno != 5:  # Linux/macOS PTY EOF may be EIO.
                raise
            break
        if not chunk:
            break
        output.extend(chunk)
        if len(output) > 32 * 1024:
            raise RuntimeError('PTY output exceeded fixture limit')
    else:
        raise RuntimeError('PTY fixture exceeded deadline')
    _, status = os.waitpid(pid, 0)
    pid = 0
    if status != 0:
        raise RuntimeError('PTY fixture controller failed')
    result = json.loads(os.read(result_reader, 4096))
    result['output'] = output.decode('utf-8', errors='replace')
    print(json.dumps(result))
finally:
    os.close(master)
    os.close(result_reader)
    if pid:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)

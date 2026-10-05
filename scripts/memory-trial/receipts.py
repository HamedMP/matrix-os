#!/usr/bin/env python3
"""Collect bounded public runtime receipts, then publish by atomic rename."""
import json
import os
import pathlib
import stat
import subprocess
import sys

MAX_RECEIPT_BYTES = 262144

def protected_file(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or info.st_mode & 0o037):
        raise ValueError('Receipt must be a protected operator-owned regular file')

def publish_receipt(path, command):
    root_info = path.parent.lstat()
    if (not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != os.geteuid()
            or root_info.st_mode & 0o022):
        raise ValueError('Receipt root must be operator controlled')
    pending = path.with_name('.' + path.name + '.pending')
    # Fixed staging names bound interrupted files; installer lock serializes cleanup.
    try:
        protected_file(pending)
    except FileNotFoundError:
        pass
    else:
        pending.unlink()
    try:
        protected_file(path)
    except FileNotFoundError:
        pass
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as output:
            subprocess.run(command, stdout=output, stderr=subprocess.DEVNULL, timeout=30, check=True)
            output.flush()
            size = os.fstat(output.fileno()).st_size
            if size < 1 or size > MAX_RECEIPT_BYTES:
                raise ValueError('Receipt size is invalid')
            if path.suffix == '.json':
                json.loads(pending.read_bytes())
            os.fchmod(output.fileno(), 0o640)
            os.fsync(output.fileno())
        os.replace(pending, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        pending.unlink(missing_ok=True)

if __name__ == '__main__':
    try:
        if len(sys.argv) < 4:
            raise ValueError('Missing receipt command')
        publish_receipt(pathlib.Path(sys.argv[1]), sys.argv[2:])
    except (ValueError, OSError, subprocess.SubprocessError):
        print('Trial runtime receipt could not be prepared; prior receipt preserved.', file=sys.stderr)
        sys.exit(1)

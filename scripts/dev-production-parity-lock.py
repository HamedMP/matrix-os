#!/usr/bin/env python3
"""Exec a local parity launcher while holding a checkout-scoped advisory lock."""

import errno
import fcntl
import os
import sys


def main():
    if len(sys.argv) < 4:
        raise ValueError("usage: dev-production-parity-lock.py <lock-path> <command> <args...>")

    lock_path = sys.argv[1]
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(lock_fd)
        if error.errno in (errno.EACCES, errno.EAGAIN):
            print("Another local parity up/down command is already running for this checkout", file=sys.stderr)
            return 1
        raise

    # Python marks descriptors close-on-exec by default. Keeping this descriptor
    # open makes the exec'd Node launcher itself own the lock until it exits.
    os.set_inheritable(lock_fd, True)
    environment = os.environ.copy()
    environment["MATRIX_PARITY_LAUNCHER_LOCKED"] = "1"
    os.execve(sys.argv[2], sys.argv[2:], environment)


if __name__ == "__main__":
    sys.exit(main())

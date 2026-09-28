"""Dead-man guard for spec 535 A0b, installed on a pr-<N> home by preview-collaboration-home.py.

`restore <nonce> [--restart]` puts the pre-connection host environment back unless
the connection with that nonce was committed; the rollback copy carries the
original owner, group and mode, so one rename restores all three. `commit <nonce>`
records a verified connection and refuses once a restore has run. Both hold one
lock, so a guard timer firing during a commit cannot interleave with it.
Idempotent; prints a fixed status only."""
import fcntl
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROLLBACK = ".host.env.preview-collaboration-rollback"
COMMIT = ".preview-collaboration-commit"


def locked(root):
    fd = os.open(root / ".preview-collaboration.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def committed(root):
    try:
        fd = os.open(root / COMMIT, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return ""
    try:
        return os.read(fd, 128).decode("ascii").strip()
    finally:
        os.close(fd)


def commit(root, nonce):
    lock = locked(root)
    try:
        if not os.path.isfile(root / ROLLBACK):
            raise ValueError("The connection was already restored")
        fd, temporary = tempfile.mkstemp(prefix=".pc-tmp.", dir=root)
        try:
            with os.fdopen(fd, "w", encoding="ascii") as target:
                target.write(nonce + "\n")
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, root / COMMIT)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)
    finally:
        os.close(lock)
    return "committed"


def restore(root, nonce, restart=None):
    lock = locked(root)
    try:
        if committed(root) == nonce:
            return "committed"
        rollback = root / ROLLBACK
        try:
            metadata = os.lstat(rollback)
        except FileNotFoundError:
            return "none"
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o022:
            raise ValueError("Unsafe rollback copy")
        os.replace(rollback, root / "host.env")
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.close(lock)
    if restart:
        restart()
    return "restored"


def restart_gateway():
    subprocess.run(["/usr/bin/systemctl", "restart", "matrix-gateway.service"], check=True, timeout=120)


if __name__ == "__main__":
    home = Path("/opt/matrix/env")
    arguments = sys.argv[1:]
    if len(arguments) < 2 or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", arguments[1]):
        raise ValueError("Invalid arguments")
    if arguments[0] == "commit" and len(arguments) == 2:
        status = commit(home, arguments[1])
    elif arguments[0] == "restore" and arguments[2:] in ([], ["--restart"]):
        status = restore(home, arguments[1], restart_gateway if arguments[2:] else None)
    else:
        raise ValueError("Invalid arguments")
    print(json.dumps({"status": status}))

"""Dead-man guard for spec 535 A0b on a pr-<N> home.

The run that claimed a connection last owns it. A run arms its guard timer first,
then `claim <nonce>` installs this guard (the exact source the loader ran) and
records the claim, so ownership only moves to a run whose timer already covers
the home, and host.env changes only after that. `restore <nonce> [--restart]`
puts the pre-connection host environment back only while that run's claim is
uncommitted, so an earlier run's timer never undoes a newer connection; the
rollback copy carries the original owner, group and mode. `commit <nonce>`
records a verified connection and refuses once a restore has run. Claim, commit,
restore and the apply step share one lock. Prints a fixed status only."""
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
STATE = ".preview-collaboration-state"


def locked(root):
    fd = os.open(root / ".preview-collaboration.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def write_atomic(path, text, mode):
    fd, temporary = tempfile.mkstemp(prefix=".pc-tmp.", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            target.write(text)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def owner(root):
    try:
        fd = os.open(root / STATE, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {}
    try:
        return json.loads(os.read(fd, 4096))
    finally:
        os.close(fd)


def record(root, nonce, state):
    write_atomic(root / STATE, json.dumps({"nonce": nonce, "state": state}), 0o600)


def claim(root, nonce, source):
    if not source:
        raise ValueError("The guard source is required to claim")
    lock = locked(root)
    try:
        write_atomic(root / ".preview-collaboration-guard.py", source, 0o700)
        record(root, nonce, "claimed")
    finally:
        os.close(lock)
    return "claimed"


def commit(root, nonce):
    lock = locked(root)
    try:
        if owner(root) != {"nonce": nonce, "state": "claimed"} or not os.path.isfile(root / ROLLBACK):
            raise ValueError("This run no longer owns an applied connection")
        record(root, nonce, "committed")
    finally:
        os.close(lock)
    return "committed"


def restore(root, nonce, restart=None):
    lock = locked(root)
    try:
        if owner(root) != {"nonce": nonce, "state": "claimed"}:
            return "unchanged"
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
        record(root, nonce, "restored")
    finally:
        os.close(lock)
    if restart:
        restart()
    return "restored"


def restart_gateway():
    subprocess.run(["/usr/bin/systemctl", "restart", "matrix-gateway.service"], check=True, timeout=120)


if __name__ == "__main__":
    home = Path("/opt/matrix/env")
    command, arguments = sys.argv[1:2], sys.argv[2:]
    if not arguments or not re.fullmatch(r"[0-9]{1,20}-[0-9]{1,5}", arguments[0]):
        raise ValueError("Invalid arguments")
    if command == ["claim"] and len(arguments) == 1:
        status = claim(home, arguments[0], globals().get("LOADED_SOURCE", ""))
    elif command == ["commit"] and len(arguments) == 1:
        status = commit(home, arguments[0])
    elif command == ["restore"] and arguments[1:] in ([], ["--restart"]):
        status = restore(home, arguments[0], restart_gateway if arguments[1:] else None)
    else:
        raise ValueError("Invalid arguments")
    print(json.dumps({"status": status}))

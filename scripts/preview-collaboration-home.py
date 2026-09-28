"""Spec 535 A0b, as root: bind a pr-<N> home to its preview collaboration authority.
Runs only after its run claimed the connection and armed the guard."""
import json
import os
import re
import shlex
import stat
import sys
import tempfile
from pathlib import Path

ORIGIN = r"https://[A-Za-z0-9.-]{1,253}"
KEYS = {"PLATFORM_INTERNAL_URL", "UPGRADE_TOKEN", "MATRIX_COLLABORATION_CLIENT_ORIGINS"}
PIN = "MATRIX_UPDATE_MANIFEST_BASE_URL"


def read_env(path, root_owned):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        meta = os.fstat(fd)
        if (not stat.S_ISREG(meta.st_mode) or meta.st_size > 1 << 20 or meta.st_mode & 0o022
                or (root_owned and meta.st_uid != 0)):
            raise ValueError("Unsafe host environment file")
        return meta, os.read(fd, (1 << 20) + 1).decode("utf-8")
    finally:
        os.close(fd)


def values(lines, key):
    return [shlex.split(line.split("=", 1)[1]) for line in lines if line.split("=", 1)[0] == key]


def one(lines, key):
    found = values(lines, key)
    if len(found) != 1 or len(found[0]) != 1:
        raise ValueError("Invalid host identity")
    return found[0][0]


def check_identity(lines, handle, owner, machine):
    if (not re.fullmatch(r"pr-[1-9][0-9]{0,8}", handle) or one(lines, "MATRIX_HANDLE") != handle
            or one(lines, "MATRIX_RUNTIME_SLOT") != handle or one(lines, "MATRIX_MACHINE_ID") != machine
            or one(lines, "MATRIX_CLERK_USER_ID") != owner or values(lines, "MATRIX_USER_ID") not in ([], [[owner]])):
        raise ValueError("Not this preview")


def write_like(path, text, meta, mode):
    fd, temporary = tempfile.mkstemp(prefix=".pc-tmp.", dir=path.parent)
    try:
        os.fchown(fd, meta.st_uid, meta.st_gid)
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            target.write(text)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def apply(root, handle, owner, machine, config, root_owned=True):
    path = root / "host.env"
    meta, text = read_env(path, root_owned)
    mode = stat.S_IMODE(meta.st_mode)
    lines = text.splitlines()
    check_identity(lines, handle, owner, machine)
    if (not isinstance(config, dict) or set(config) != KEYS
            or not re.fullmatch(ORIGIN, config["PLATFORM_INTERNAL_URL"])
            or not re.fullmatch(r"[a-f0-9]{64}", config["UPGRADE_TOKEN"])
            or not re.fullmatch(f"{ORIGIN}(,{ORIGIN}){{0,15}}", config["MATRIX_COLLABORATION_CLIENT_ORIGINS"])):
        raise ValueError("Invalid binding")
    # Single rollback copy: host.env before the first connection.
    rollback = root / ".host.env.preview-collaboration-rollback"
    try:
        original = read_env(rollback, root_owned)[1].splitlines()
    except FileNotFoundError:
        write_like(rollback, text, meta, mode)
        original = lines
    check_identity(original, handle, owner, machine)
    # Releases stay on the platform that published the bundle.
    pin = values(original, PIN) or values(original, "PLATFORM_INTERNAL_URL")
    if len(pin) != 1 or len(pin[0]) != 1 or not re.fullmatch(ORIGIN + "/?", pin[0][0]):
        raise ValueError("Invalid original binding")
    config = {**config, PIN: pin[0][0]}
    kept = [line for line in lines if line.split("=", 1)[0] not in config]
    write_like(path, "\n".join(kept + [f"{key}={config[key]}" for key in sorted(config)]) + "\n", meta, mode)
    after = os.lstat(path)
    if (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) != (meta.st_uid, meta.st_gid, mode):
        raise ValueError("Metadata changed")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise ValueError("Invalid arguments")
    apply(Path("/opt/matrix/env"), *sys.argv[1:4], json.loads(sys.argv[4]))
    print(json.dumps({"status": "applied"}))

"""Root step of spec 535 A0b: bind a pr-<N> home to its preview collaboration authority.

`<nonce> <handle> <owner> <machine ID> <binding JSON>` re-points only the
collaboration binding in host.env, keeping the file's owner, group and mode and a
single immutable origin copy and one uncommitted-attempt rollback snapshot. It runs
only while this run owns the connection (its guard is armed and its claim is
recorded), under the guard's lock, so a guard restore never interleaves with it.
Prints a fixed status only, never the file or a value."""
import hashlib
import hmac
import urllib.request
import fcntl
import json
import os
import re
import shlex
import stat
import sys
import tempfile
from pathlib import Path

ORIGIN = r"https://[A-Za-z0-9.-]{1,253}"
PIN = "MATRIX_UPDATE_MANIFEST_BASE_URL"
KEYS = {"PLATFORM_INTERNAL_URL", "UPGRADE_TOKEN", "MATRIX_COLLABORATION_CLIENT_ORIGINS"}
PREVIEW_AUTH = "MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN"
ROLLBACK = ".host.env.preview-collaboration-rollback"
ATTEMPT_ROLLBACK = ".host.env.preview-collaboration-attempt-rollback"


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
        raise ValueError("Host is not this collaboration preview")


def check_binding(config):
    if (not isinstance(config, dict) or set(config) not in (KEYS, KEYS | {PREVIEW_AUTH})
            or not re.fullmatch(ORIGIN, config["PLATFORM_INTERNAL_URL"])
            or not re.fullmatch(r"[a-f0-9]{64}", config["UPGRADE_TOKEN"])
            or (PREVIEW_AUTH in config and config[PREVIEW_AUTH] != config["UPGRADE_TOKEN"])
            or not re.fullmatch(f"{ORIGIN}(,{ORIGIN}){{0,15}}", config["MATRIX_COLLABORATION_CLIENT_ORIGINS"])):
        raise ValueError("Invalid preview collaboration binding")


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


def owns(root, nonce):
    try:
        fd = os.open(root / ".preview-collaboration-state", os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return False
    with os.fdopen(fd, encoding="utf-8") as state:
        return json.load(state) == {"nonce": nonce, "state": "claimed"}


def bind(root, handle, owner, machine, config, root_owned):
    path = root / "host.env"
    meta, text = read_env(path, root_owned)
    mode = stat.S_IMODE(meta.st_mode)
    lines = text.splitlines()
    check_identity(lines, handle, owner, machine)
    check_binding(config)
    rollback = root / ROLLBACK
    try:
        original = read_env(rollback, root_owned)[1].splitlines()
    except FileNotFoundError:
        write_like(rollback, text, meta, mode)
        original = lines
    check_identity(original, handle, owner, machine)
    # Release metadata stays on the platform that published the preview bundle.
    pin = values(original, PIN) or values(original, "PLATFORM_INTERNAL_URL")
    if len(pin) != 1 or len(pin[0]) != 1 or not re.fullmatch(ORIGIN + "/?", pin[0][0]):
        raise ValueError("Invalid original platform binding")
    # Keep release provenance immutable, but restore this attempt to its last committed binding.
    attempt = root / ATTEMPT_ROLLBACK
    try:
        baseline = read_env(attempt, root_owned)[1].splitlines()
    except FileNotFoundError:
        write_like(attempt, text, meta, mode)
        baseline = lines
    check_identity(baseline, handle, owner, machine)
    config = {**config, PIN: pin[0][0], **({"MATRIX_PREVIEW_RUNTIME": "true"} if PREVIEW_AUTH in config else {})}
    kept = [line for line in lines if line.split("=", 1)[0] not in config]
    write_like(path, "\n".join(kept + [f"{key}={config[key]}" for key in sorted(config)]) + "\n", meta, mode)
    after = os.lstat(path)
    if (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) != (meta.st_uid, meta.st_gid, mode):
        raise ValueError("Host environment metadata changed")


def apply(root, nonce, handle, owner, machine, config, root_owned=True):
    lock = os.open(root / ".preview-collaboration.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not owns(root, nonce):
            raise ValueError("This run does not own the preview collaboration connection")
        bind(root, handle, owner, machine, config, root_owned)
    finally:
        os.close(lock)


def probe(root, gateway="http://127.0.0.1:4000"):
    lines = read_env(root / "host.env", False)[1].splitlines()
    token = one(lines, PREVIEW_AUTH)
    owner = one(lines, "MATRIX_CLERK_USER_ID")
    if not re.fullmatch(r"[a-f0-9]{64}", token) or not re.fullmatch(r"user_[A-Za-z0-9_-]{1,128}", owner):
        raise ValueError("Invalid preview authentication binding")
    proof = hmac.new(token.encode(), owner.encode(), hashlib.sha256).hexdigest()
    request = urllib.request.Request(f"{gateway}/api/system/info", headers={
        "authorization": f"Bearer {token}", "x-platform-user-id": owner, "x-platform-verified": proof})
    with urllib.request.urlopen(request, timeout=10) as response:
        raw = response.read(32 * 1024 + 1)
        if response.status != 200 or len(raw) > 32 * 1024 or json.loads(raw).get("capabilities", {}).get("collaboration") is not True:
            raise ValueError("Preview owner API authentication unavailable")
    return {"previewAuthenticated": True}


if __name__ == "__main__":
    if sys.argv[1:] == ["probe"]:
        print(json.dumps(probe(Path("/opt/matrix/env"))))
        sys.exit(0)
    if len(sys.argv) != 6 or not re.fullmatch(r"[0-9]{1,20}-[0-9]{1,5}", sys.argv[1]):
        raise ValueError("Expected nonce, handle, owner, machine ID and binding")
    apply(Path("/opt/matrix/env"), *sys.argv[1:5], json.loads(sys.argv[5]))
    print(json.dumps({"status": "applied"}))

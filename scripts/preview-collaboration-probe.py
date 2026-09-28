"""Read-only steps of spec 535 A0b, run as the runtime user on a pr-<N> home.

`identity <handle> <owner>` prints the machine ID once the host proves it is that
collaboration preview; `health` prints whether the local gateway is healthy and
reports collaboration configured. Never prints the file or a secret. Kept under
the 4096-character terminal argument cap."""
import json
import os
import re
import shlex
import stat
import sys
import urllib.request
from pathlib import Path

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
GATEWAY = "http://127.0.0.1:4000"


def read_lines(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_size > 1 << 20 or meta.st_mode & 0o022:
            raise ValueError("Unsafe host environment file")
        return os.read(fd, (1 << 20) + 1).decode("utf-8").splitlines()
    finally:
        os.close(fd)


def values(lines, key):
    return [shlex.split(line.split("=", 1)[1]) for line in lines if line.split("=", 1)[0] == key]


def one(lines, key):
    found = values(lines, key)
    if len(found) != 1 or len(found[0]) != 1:
        raise ValueError("Invalid host identity")
    return found[0][0]


def identity(root, handle, owner):
    lines = read_lines(root / "host.env")
    machine = one(lines, "MATRIX_MACHINE_ID")
    if (not re.fullmatch(r"pr-[1-9][0-9]{0,8}", handle) or one(lines, "MATRIX_HANDLE") != handle
            or one(lines, "MATRIX_RUNTIME_SLOT") != handle or not re.fullmatch(UUID, machine)
            or one(lines, "MATRIX_CLERK_USER_ID") != owner or values(lines, "MATRIX_USER_ID") not in ([], [[owner]])):
        raise ValueError("Not this preview")
    return machine


def health(root, opener=urllib.request.urlopen):
    token = one(read_lines(root / "host.env"), "MATRIX_AUTH_TOKEN")
    with opener(f"{GATEWAY}/health", timeout=10) as response:
        healthy = response.status == 200
    request = urllib.request.Request(f"{GATEWAY}/api/system/info", headers={"authorization": f"Bearer {token}"})
    with opener(request, timeout=10) as response:
        capabilities = json.load(response).get("capabilities") or {}
    return {"healthy": healthy, "collaboration": capabilities.get("collaboration") is True}


if __name__ == "__main__":
    home = Path("/opt/matrix/env")
    if sys.argv[1:2] == ["identity"] and len(sys.argv) == 4:
        print(json.dumps({"machineId": identity(home, *sys.argv[2:])}))
    elif sys.argv[1:] == ["health"]:
        print(json.dumps(health(home)))
    else:
        raise ValueError("Invalid arguments")

"""Operator-only recovery after authenticated fleet and exact bundle verification.

This is not a registration endpoint or a rule for accepting HTTP 409. The trusted
Preview workflow supplies the already-running machine identity from platform DB.
"""
import json
import ipaddress
import os
from pathlib import Path
import re
import shlex
import stat
import sys
import urllib.request


def read_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("Invalid recovery input")
        return os.read(fd, limit + 1).decode("utf-8")
    finally:
        os.close(fd)


def recover(root, handle, machine_id, version, address, actual_address):
    if not re.fullmatch(r"pr-[1-9][0-9]{0,9}", handle):
        raise ValueError("Only disposable previews may be recovered")
    if not machine_id or str(ipaddress.IPv4Address(address)) != actual_address:
        raise ValueError("Preview machine identity mismatch")
    values = {}
    for line in read_regular(root / "env/host.env", 65536).splitlines():
        key, separator, value = line.partition("=")
        if separator and key in ("MATRIX_HANDLE", "MATRIX_MACHINE_ID"):
            tokens = shlex.split(value)
            if len(tokens) != 1:
                raise ValueError("Invalid machine identity")
            values[key] = tokens[0]
    if values != {"MATRIX_HANDLE": handle, "MATRIX_MACHINE_ID": machine_id}:
        raise ValueError("Preview host identity mismatch")
    if read_regular(root / "app/BUNDLE_VERSION", 256).strip() != version:
        raise ValueError("Preview version mismatch")
    marker = root / "register-complete"
    if marker.is_symlink():
        raise ValueError("Registration marker must not be a symlink")
    try:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    except FileExistsError:
        read_regular(marker, 4096)
    else:
        with os.fdopen(fd, "w") as output:
            json.dump({"handle": handle, "machineId": machine_id, "version": version}, output)
            output.flush()
            os.fsync(output.fileno())
    print("Verified Preview registration marker")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise ValueError("Expected handle, machine ID, version, public IPv4")
    with urllib.request.urlopen("http://169.254.169.254/hetzner/v1/metadata/public-ipv4", timeout=10) as response:
        actual = response.read(128).decode("ascii").strip()
    recover(Path("/opt/matrix"), *sys.argv[1:], actual)

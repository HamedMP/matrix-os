"""Prove a disposable preview's installed source without reading owner data."""
import json
import os
import re
import stat
import sys
from pathlib import Path


def read_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= limit:
            raise ValueError("Invalid release metadata")
        value = os.read(fd, limit + 1)
        if len(value) > limit:
            raise ValueError("Oversized release metadata")
        return value.decode("utf-8")
    finally:
        os.close(fd)


def installed_provenance(root, handle, version, expected):
    if not re.fullmatch(r"pr-[1-9][0-9]{0,8}", handle) or not re.fullmatch(r"[a-f0-9]{40}", expected):
        raise ValueError("Invalid preview target")
    pattern = rf"v\d{{4}}\.\d{{2}}\.\d{{2}}-{handle.replace('pr-', 'pr')}(?:-[1-9]\d*-[1-9]\d*)?-{expected[:7]}"
    if not re.fullmatch(pattern, version):
        raise ValueError("Invalid preview version")
    release = json.loads(read_regular(root / "release.json", 65536))
    active = read_regular(root / "app" / "BUNDLE_VERSION", 256).strip()
    if not isinstance(release, dict) or not (
        type(release.get("schemaVersion")) is int and release["schemaVersion"] == 1
        and release.get("kind") == "matrix-os-host-bundle" and release.get("channel") == "none"
        and release.get("version") == version and active == version and release.get("gitCommit") == expected
    ):
        raise ValueError("Installed preview does not match target")
    return {"schemaVersion": 1, "kind": "matrix-os-preview-runtime", "channel": "none",
            "handle": handle, "version": version, "gitCommit": expected}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise ValueError("Invalid arguments")
        print(json.dumps(installed_provenance(Path("/opt/matrix"), *sys.argv[1:])))
    except (ValueError, TypeError, OSError, UnicodeError, RecursionError):
        print("Installed preview provenance could not be verified.", file=sys.stderr)
        sys.exit(1)

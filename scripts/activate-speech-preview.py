#!/usr/bin/env python3
"""Atomically add a narrow speech-preview capability to one disposable host."""

import argparse
import os
import re
import stat
import tempfile
from urllib.parse import urlparse


MANAGED_KEYS = {
    "MATRIX_PLATFORM_SPEECH_ENABLED",
    "MATRIX_PLATFORM_SPEECH_ORIGIN",
    "MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN",
}
IDENTITY_KEYS = {
    "MATRIX_HANDLE": "handle",
    "MATRIX_MACHINE_ID": "machine_id",
    "MATRIX_CLERK_USER_ID": "owner_id",
    "MATRIX_RUNTIME_SLOT": "runtime_slot",
}


def valid_atom(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", value))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", default="/opt/matrix/env/host.env")
    parser.add_argument("--handle", required=True)
    parser.add_argument("--machine-id", required=True)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--runtime-slot", required=True)
    parser.add_argument("--speech-origin", required=True)
    parser.add_argument("--speech-runtime-token", required=True)
    args = parser.parse_args()

    if not re.fullmatch(r"pr-[1-9][0-9]{0,8}", args.handle) or args.runtime_slot != args.handle:
        raise ValueError("activation is limited to an exact PR preview")
    if not all(valid_atom(value) for value in (args.machine_id, args.owner_id)):
        raise ValueError("invalid preview identity")
    parsed = urlparse(args.speech_origin)
    prefix = f"{args.handle}---"
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or not (parsed.hostname or "").startswith(prefix)
            or not (parsed.hostname or "").endswith(".a.run.app")):
        raise ValueError("invalid tagged speech preview origin")
    if not re.fullmatch(r"[a-f0-9]{64}", args.speech_runtime_token):
        raise ValueError("invalid speech runtime token")

    path = os.path.abspath(args.env_file)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024 * 1024:
            raise ValueError("invalid host environment file")
        raw = os.read(fd, metadata.st_size + 1).decode("utf-8")
    finally:
        os.close(fd)

    lines = raw.splitlines()
    current = {}
    preserved = []
    for line in lines:
        key = line.split("=", 1)[0]
        if key in IDENTITY_KEYS:
            current[key] = line.split("=", 1)[1] if "=" in line else ""
        if key not in MANAGED_KEYS:
            preserved.append(line)
    expected = {
        "MATRIX_HANDLE": args.handle,
        "MATRIX_MACHINE_ID": args.machine_id,
        "MATRIX_CLERK_USER_ID": args.owner_id,
        "MATRIX_RUNTIME_SLOT": args.runtime_slot,
    }
    if any(current.get(key) != value for key, value in expected.items()):
        raise ValueError("host identity does not match activation artifact")

    rendered = "\n".join(preserved + [
        "MATRIX_PLATFORM_SPEECH_ENABLED=true",
        f"MATRIX_PLATFORM_SPEECH_ORIGIN={args.speech_origin.rstrip('/')}",
        f"MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN={args.speech_runtime_token}",
    ]) + "\n"
    directory = os.path.dirname(path)
    temp_fd, temp_path = tempfile.mkstemp(prefix=".host.env.speech-", dir=directory)
    try:
        os.fchmod(temp_fd, stat.S_IMODE(metadata.st_mode))
        os.fchown(temp_fd, metadata.st_uid, metadata.st_gid)
        with os.fdopen(temp_fd, "w", encoding="utf-8") as stream:
            stream.write(rendered)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        try:
            os.close(temp_fd)
        except OSError:
            pass
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        raise


if __name__ == "__main__":
    main()

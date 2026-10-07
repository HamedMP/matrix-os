#!/usr/bin/python3 -I
"""Root-only activation of machine-bound managed images configuration."""
import json
import os
import re
import stat
import sys
import tempfile
from urllib.parse import urlparse

ENV_PATH = "/opt/matrix/env/host.env"
BACKUP_PATH = "/opt/matrix/env/host.env.pre-platform-images"
CONFIG_KEYS = {
    "MATRIX_PLATFORM_IMAGE_ENABLED",
    "MATRIX_PLATFORM_IMAGE_ORIGIN",
    "MATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN",
}


def read_regular(path, maximum):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum or info.st_mode & 0o022:
        raise ValueError("Unsafe host environment")
    with open(path, "rb") as file:
        value = file.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError("Unsafe host environment")
    return value, info


def one_value(lines, key):
    values = [line[len(key) + 1:] for line in lines if line.startswith(key + "=")]
    if len(values) != 1:
        raise ValueError("Invalid host environment")
    return values[0]


def validate_config(value):
    if not isinstance(value, dict) or set(value) != {
        "machineId", "runtimeSlot", "enabled", "origin", "runtimeToken"
    }:
        raise ValueError("Invalid images configuration")
    if (not isinstance(value["machineId"], str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value["machineId"])
            or not isinstance(value["runtimeSlot"], str)
            or not re.fullmatch(r"[a-z0-9-]{1,32}", value["runtimeSlot"])
            or value["enabled"] is not True
            or not isinstance(value["runtimeToken"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", value["runtimeToken"])):
        raise ValueError("Invalid images configuration")
    if not isinstance(value["origin"], str) or len(value["origin"]) > 512:
        raise ValueError("Invalid images configuration")
    parsed = urlparse(value["origin"])
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise ValueError("Invalid images configuration")
    return value


def write_backup(path, data, source_info):
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        read_regular(path, 65536)
        return
    with os.fdopen(descriptor, "wb") as file:
        os.fchmod(file.fileno(), stat.S_IMODE(source_info.st_mode))
        os.fchown(file.fileno(), source_info.st_uid, source_info.st_gid)
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


def apply_config(env_path, backup_path, raw_config):
    config = validate_config(raw_config)
    env_bytes, original = read_regular(env_path, 65536)
    lines = env_bytes.decode("utf-8").split("\n")
    if (one_value(lines, "MATRIX_MACHINE_ID") != config["machineId"]
            or one_value(lines, "MATRIX_RUNTIME_SLOT") != config["runtimeSlot"]):
        raise ValueError("Speech configuration target does not match this host")
    for key in CONFIG_KEYS:
        if len([line for line in lines if line.startswith(key + "=")]) > 1:
            raise ValueError("Invalid host environment")

    replacements = {
        "MATRIX_PLATFORM_IMAGE_ENABLED": "true",
        "MATRIX_PLATFORM_IMAGE_ORIGIN": config["origin"].rstrip("/"),
        "MATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN": config["runtimeToken"],
    }
    found = set()
    next_lines = []
    for line in lines:
        key = line.split("=", 1)[0]
        if key in replacements:
            next_lines.append(key + "=" + replacements[key])
            found.add(key)
        else:
            next_lines.append(line)
    insertion = len(next_lines) - 1 if next_lines and next_lines[-1] == "" else len(next_lines)
    for key in sorted(CONFIG_KEYS - found):
        next_lines.insert(insertion, key + "=" + replacements[key])
        insertion += 1

    write_backup(backup_path, env_bytes, original)
    directory = os.path.dirname(os.path.abspath(env_path))
    descriptor, temporary = tempfile.mkstemp(prefix=".host.env.platform-images-", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as file:
            os.fchmod(file.fileno(), stat.S_IMODE(original.st_mode))
            os.fchown(file.fileno(), original.st_uid, original.st_gid)
            file.write("\n".join(next_lines).encode("utf-8"))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, env_path)
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError("Root activation is required")
    raw = sys.stdin.buffer.read(4097)
    if len(raw) > 4096:
        raise ValueError("Invalid images configuration")
    apply_config(ENV_PATH, BACKUP_PATH, json.loads(raw))
    print("Platform images configuration installed.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Platform images configuration failed.", file=sys.stderr)
        sys.exit(1)

"""Fail-closed fixed root policy and immutable installed harness input checks."""
import hashlib
import os
from pathlib import Path
import re
import stat
from lease_contract import hex_value
from lease_io import decode


def read_owned(path, owner=0, limit=1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022 or info.st_size > limit:
            raise ValueError('Untrusted installed input')
        data = file.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Installed input exceeds bound')
        return data


def read_owned_json(path, owner=0):
    return decode(read_owned(path, owner, 16384))


def validate_config(value):
    keys = {'repository', 'controllerShas', 'imageDigest', 'harnessDigest', 'modes'}
    if not isinstance(value, dict) or set(value) != keys or value['repository'] != 'HamedMP/matrix-os':
        raise ValueError('Invalid fixed admission policy')
    shas, modes = value['controllerShas'], value['modes']
    if (not isinstance(shas, list) or not 1 <= len(shas) <= 16
            or not all(hex_value(s, 40) for s in shas) or len(set(shas)) != len(shas)):
        raise ValueError('Invalid approved controller revisions')
    if (not isinstance(modes, list) or not 1 <= len(modes) <= 2
            or any(m not in ('shadow', 'delegated') for m in modes) or len(set(modes)) != len(modes)):
        raise ValueError('Invalid approved admission modes')
    if not isinstance(value['imageDigest'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', value['imageDigest']) or not hex_value(value['harnessDigest'], 64):
        raise ValueError('Invalid approved immutable execution inputs')
    return value


def verify_harness(root, digest, owner=0):
    root = Path(root)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
        raise ValueError('Untrusted harness installation')
    raw = read_owned(root / 'harness.sha256', owner, 16384)
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('Installed harness identity differs from approval')
    lines = raw.decode('ascii').splitlines()
    if not 1 <= len(lines) <= 64:
        raise ValueError('Harness manifest entry cap')
    seen, total = set(), 0
    for line in lines:
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_./-]+)', line)
        if not match:
            raise ValueError('Invalid installed manifest')
        expected, name = match.groups()
        parts = Path(name).parts
        if name.startswith('/') or any(part in ('..', '.') for part in parts) or name in seen:
            raise ValueError('Invalid installed input path')
        seen.add(name)
        for index in range(1, len(parts)):
            info = root.joinpath(*parts[:index]).lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
                raise ValueError('Untrusted installed input parent')
        data = read_owned(root / name, owner)
        total += len(data)
        if total > 4 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError('Installed harness input differs from manifest')

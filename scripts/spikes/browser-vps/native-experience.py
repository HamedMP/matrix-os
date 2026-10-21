#!/usr/bin/python3
"""Trusted-source, isolated-stdlib setup for the exact disposable browser preview."""
import json
import os
from pathlib import Path
import re
import secrets
import sys

NAMES = frozenset(('tint2rc', 'matrix-browser-lab-desktop.service',
                   'matrix-browser-lab-panel.service', 'matrix-browser-lab-chrome.service'))


def assert_target(environment, expected):
    lines = environment.splitlines()
    handles = [line for line in lines if line.startswith('MATRIX_HANDLE=')]
    slots = [line for line in lines if line.startswith('MATRIX_RUNTIME_SLOT=')]
    if not re.fullmatch(r'pr-[1-9][0-9]{0,9}', expected) or handles != ['MATRIX_HANDLE=' + expected] or slots != ['MATRIX_RUNTIME_SLOT=' + expected]:
        raise ValueError('Target is not the confirmed disposable preview')
    return expected


def read_host_environment():
    with open('/opt/matrix/env/host.env', encoding='utf8') as source:
        text = source.read(131073)
    if len(text) > 131072:
        raise ValueError('Host environment limit')
    return text


def load_files(path):
    with open(path, encoding='utf8') as source:
        text = source.read(131073)
    if len(text) > 131072:
        raise ValueError('Native unit data limit')
    files = json.loads(text)
    if not isinstance(files, dict) or set(files) != NAMES or any(not isinstance(content, str) or len(content) > 32768 or '\0' in content for content in files.values()):
        raise ValueError('Invalid native unit data')
    return files


def atomic_write(parent, name, content, owner_uid=0):
    if name not in NAMES:
        raise ValueError('Invalid native unit name')
    descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = name + '.' + secrets.token_hex(16) + '.tmp'
    created = False
    try:
        directory = os.fstat(descriptor)
        if directory.st_uid != owner_uid or directory.st_mode & 0o022:
            raise ValueError('Unsafe native unit directory')
        file_descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=descriptor)
        created = True
        with os.fdopen(file_descriptor, 'w', encoding='utf8') as target:
            os.fchmod(target.fileno(), 0o644)
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        # Rename replaces a destination symlink rather than following it.
        os.replace(temporary, name, src_dir_fd=descriptor, dst_dir_fd=descriptor)
        created = False
    finally:
        try:
            if created:
                os.unlink(temporary, dir_fd=descriptor)
        finally:
            os.close(descriptor)


def main(arguments):
    if os.getuid() != 0 or len(arguments) != 2 or arguments[0] not in ('guard', 'install'):
        raise ValueError('Root-only preview setup: guard|install pr-<number>')
    assert_target(read_host_environment(), arguments[1])
    if arguments[0] == 'guard':
        return
    files = load_files(Path(__file__).resolve().with_name('native-experience.json'))
    for name, content in files.items():
        atomic_write('/opt/matrix-browser-lab' if name == 'tint2rc' else '/etc/systemd/system', name, content)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, TypeError) as error:
        print('Native experience setup refused: ' + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)

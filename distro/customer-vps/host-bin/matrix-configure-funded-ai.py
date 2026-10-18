#!/usr/bin/python3 -I
"""Install only current, identity-bound managed AI configuration. Owner data is untouched."""
import datetime
import fcntl
import json
import os
import re
import stat
import sys
import tempfile
import time
import uuid

ENV_PATH = '/opt/matrix/env/host.env'
MARKERS = ('/opt/matrix/staging/update-phase', '/opt/matrix/staging/update-transaction',
           '/opt/matrix/app/.update-now', '/opt/matrix/app/.rollback-now',
           '/opt/matrix/env/runtime-token-rotation.pending', '/var/lib/matrix-funded-host-config/install-pending.json',
           '/var/lib/matrix-funded-host-config/resume.json', '/var/lib/matrix-funded-host-config/applied.json')
KEYS = ('MATRIX_FUNDED_AI_ENABLED', 'MATRIX_FUNDED_AI_PLATFORM_URL', 'MATRIX_FUNDED_AI_RELAY_URL',
        'MATRIX_FUNDED_AI_RUNTIME_TOKEN', 'MATRIX_RUNTIME_TOKEN_EPOCH')
IDENTITY_KEYS = ('MATRIX_HANDLE', 'MATRIX_MACHINE_ID', 'MATRIX_CLERK_USER_ID', 'MATRIX_RUNTIME_SLOT')


def require(condition):
    if not condition:
        raise ValueError('Invalid or unavailable host configuration')


def timestamp(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', value))
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def validate_config(value):
    require(isinstance(value, dict) and set(value) == {'contractVersion', 'identity', 'configuration', 'issuedAt', 'expiresAt'}
            and type(value['contractVersion']) is int and value['contractVersion'] == 1)
    identity, config = value['identity'], value['configuration']
    require(isinstance(identity, dict) and set(identity) == {'handle', 'machineId', 'ownerId', 'runtimeSlot', 'runtimeTokenEpoch'})
    for key, pattern in [('handle', r'[a-z0-9][a-z0-9-]{1,62}'),
                         ('machineId', r'[A-Za-z0-9_-]{1,128}'), ('ownerId', r'[A-Za-z0-9_-]{1,128}')]:
        require(isinstance(identity[key], str) and re.fullmatch(pattern, identity[key]))
    require(identity['runtimeSlot'] == 'primary' and type(identity['runtimeTokenEpoch']) is int
            and 1 <= identity['runtimeTokenEpoch'] <= 2147483647)
    require(isinstance(config, dict) and set(config) == {'enabled', 'platformOrigin', 'relayOrigin', 'runtimeToken'}
            and config['enabled'] is True and config['platformOrigin'] == 'https://app.matrix-os.com'
            and isinstance(config['relayOrigin'], str) and len(config['relayOrigin']) <= 256
            and re.fullmatch(r'https://matrix-ai-relay-production-[a-z0-9]+(?:-[a-z0-9]+)?\.a\.run\.app', config['relayOrigin'])
            and isinstance(config['runtimeToken'], str) and re.fullmatch(r'[a-f0-9]{64}', config['runtimeToken']))
    issued, expires = timestamp(value['issuedAt']), timestamp(value['expiresAt'])
    require(issued <= time.time() < expires and 0 < expires - issued <= 30)
    return identity, config


def read_regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o022
                and (os.geteuid() != 0 or info.st_uid == 0) and info.st_size <= 65536)
        data = os.read(fd, 65537)
        require(len(data) <= 65536)
        current = os.stat(path, follow_symlinks=False)
        require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino))
        return data, info
    finally:
        os.close(fd)


def snapshot(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode, info.st_uid, info.st_gid)


def write_backup(env_path, data, info):
    path = env_path + '.pre-funded-ai-' + uuid.uuid4().hex
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as out:
        os.fchown(out.fileno(), info.st_uid, info.st_gid)
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    # Sweep only regular single-link files; symlinks are never followed.
    directory, prefix = os.path.dirname(env_path), os.path.basename(env_path) + '.pre-funded-ai-'
    backups = []
    for name in os.listdir(directory):
        if name.startswith(prefix):
            candidate = os.path.join(directory, name)
            item = os.lstat(candidate)
            if stat.S_ISREG(item.st_mode) and item.st_nlink == 1:
                backups.append((item.st_mtime_ns, candidate))
    for _, candidate in sorted(backups)[:-5]:
        os.unlink(candidate)


def ensure_quiet(markers):
    require(not any(os.path.lexists(marker) for marker in markers))


def apply_config(env_path, value, markers=MARKERS):
    identity, config = validate_config(value)
    directory = os.path.dirname(os.path.abspath(env_path))
    lock = os.open(os.path.join(directory, '.host.env.funded-repair.lock'),
                   os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    temporary = None
    try:
        info = os.fstat(lock)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600
                and (os.geteuid() != 0 or info.st_uid == 0))
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ensure_quiet(markers)
        data, original = read_regular(env_path)
        lines = data.decode('utf-8').splitlines(keepends=True)
        values = {}
        for line in lines:
            bare = line.rstrip('\r\n')
            for key in KEYS + IDENTITY_KEYS:
                if re.match(r'^\s*(?:export\s+)?' + key + r'\s*=', bare):
                    require(bare.startswith(key + '=') and key not in values)
                    values[key] = bare[len(key) + 1:]
        require(all(values.get(key) == expected for key, expected in zip(IDENTITY_KEYS,
                (identity['handle'], identity['machineId'], identity['ownerId'], identity['runtimeSlot']))))
        epoch = str(identity['runtimeTokenEpoch'])
        require('MATRIX_RUNTIME_TOKEN_EPOCH' not in values or values['MATRIX_RUNTIME_TOKEN_EPOCH'] == epoch)
        require(values.get('MATRIX_FUNDED_AI_PLATFORM_URL', '') in ('', config['platformOrigin']))
        require(values.get('MATRIX_FUNDED_AI_RELAY_URL', '') in ('', config['relayOrigin']))
        replacement = {'MATRIX_FUNDED_AI_ENABLED': 'true', 'MATRIX_FUNDED_AI_PLATFORM_URL': config['platformOrigin'],
                       'MATRIX_FUNDED_AI_RELAY_URL': config['relayOrigin'],
                       'MATRIX_FUNDED_AI_RUNTIME_TOKEN': config['runtimeToken'], 'MATRIX_RUNTIME_TOKEN_EPOCH': epoch}
        output = []
        for line in lines:
            key = line.split('=', 1)[0]
            if key in replacement:
                eol = '\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
                output.append(key + '=' + replacement[key] + eol)
            else:
                output.append(line)
        missing = [key for key in KEYS if key not in values]
        if missing and output and not output[-1].endswith('\n'):
            output.append('\n')
        output.extend(key + '=' + replacement[key] + '\n' for key in missing)
        updated = ''.join(output).encode('utf-8')
        if updated == data:
            return False
        write_backup(env_path, data, original)
        fd, temporary = tempfile.mkstemp(prefix='.host.env.funded-ai-', dir=directory)
        with os.fdopen(fd, 'wb') as out:
            os.fchmod(out.fileno(), stat.S_IMODE(original.st_mode))
            os.fchown(out.fileno(), original.st_uid, original.st_gid)
            out.write(updated)
            out.flush()
            os.fsync(out.fileno())
        validate_config(value)
        ensure_quiet(markers)
        current, current_info = read_regular(env_path)
        require(current == data and snapshot(current_info) == snapshot(original))
        os.replace(temporary, env_path)
        temporary = None
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return True
    finally:
        if temporary is not None:
            os.unlink(temporary)
        os.close(lock)


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 1)
    raw = sys.stdin.buffer.read(4097)
    require(len(raw) <= 4096)
    apply_config(ENV_PATH, json.loads(raw))
    print('Managed AI configuration installed.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Managed AI configuration failed.', file=sys.stderr)
        sys.exit(1)

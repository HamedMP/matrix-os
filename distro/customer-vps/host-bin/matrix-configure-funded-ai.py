#!/usr/bin/python3 -I
"""Install only current, identity-bound managed AI configuration. Owner data is untouched."""
import datetime
from contextlib import contextmanager
import fcntl
import json
import os
import pwd
import re
import stat
import sys
import tempfile
import time
import uuid

ENV_PATH = '/opt/matrix/env/host.env'
MARKERS = ('/opt/matrix/staging/update-phase', '/opt/matrix/staging/update-transaction',
           '/opt/matrix/app/.update-now', '/opt/matrix/app/.update-repair-now', '/opt/matrix/app/.rollback-now',
           '/opt/matrix/env/runtime-token-rotation.pending', '/var/lib/matrix-funded-host-config/install-pending.json',
           '/var/lib/matrix-funded-host-config/resume.json', '/var/lib/matrix-funded-host-config/invocation.json',
           '/var/lib/matrix-funded-host-config/applied.json')
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
    require(isinstance(identity['runtimeSlot'], str)
            and re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?', identity['runtimeSlot'])
            and len(identity['runtimeSlot']) <= 32 and type(identity['runtimeTokenEpoch']) is int
            and 1 <= identity['runtimeTokenEpoch'] <= 2147483647)
    require(isinstance(config, dict) and set(config) == {'enabled', 'platformOrigin', 'relayOrigin', 'runtimeToken'}
            and config['enabled'] is True and config['platformOrigin'] == 'https://app.matrix-os.com'
            and isinstance(config['relayOrigin'], str) and len(config['relayOrigin']) <= 256
            and re.fullmatch(r'https://matrix-ai-relay-production-[a-z0-9]+(?:-[a-z0-9]+)?\.a\.run\.app', config['relayOrigin'])
            and isinstance(config['runtimeToken'], str) and re.fullmatch(r'[a-f0-9]{64}', config['runtimeToken']))
    issued, expires = timestamp(value['issuedAt']), timestamp(value['expiresAt'])
    require(issued <= time.time() < expires and 0 < expires - issued <= 30)
    return identity, config


def read_regular(path, maximum=65536, dir_fd=None, root_owned=True, allowed_owners=(0,)):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o022
                and (not root_owned or os.geteuid() != 0 or info.st_uid in allowed_owners) and info.st_size <= maximum)
        data = os.read(fd, maximum + 1)
        require(len(data) <= maximum)
        current = os.stat(path, dir_fd=dir_fd, follow_symlinks=False)
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


def safe_directory(path, allowed_owners=(0,)):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(not info.st_mode & 0o022 and (os.geteuid() != 0 or info.st_uid in allowed_owners))
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def maintenance_guards(markers):
    # Protected installs/repairs take resume.lock before writing their pending
    # records. Hold a shared lock for this entire mutation, including that gap.
    locks = []
    directories = {os.path.dirname(path) for path in markers if os.path.basename(path) in
                   ('applied.json', 'resume.json', 'invocation.json', 'install-pending.json')}
    try:
        for directory in sorted(directories):
            try:
                anchor = safe_directory(directory)
            except FileNotFoundError:
                continue
            try:
                try:
                    lock = os.open('resume.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=anchor)
                except FileNotFoundError:
                    continue
                locks.append(lock)
                info = os.fstat(lock)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600
                        and (os.geteuid() != 0 or info.st_uid == 0))
                fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            finally:
                os.close(anchor)
        yield
    finally:
        for lock in locks:
            os.close(lock)


def completed_update_transaction(path):
    # Older Sync agents write journals as their fixed system runtime account;
    # newer agents seal them as root. Neither form is an active-operation marker.
    owners = (0, pwd.getpwnam('matrix').pw_uid) if os.geteuid() == 0 else (0,)
    transaction = safe_directory(path, allowed_owners=owners)
    try:
        require(not os.path.lexists(os.path.join(path, 'same-version-repair.json')))
        require(read_regular('state', 64, transaction, allowed_owners=owners)[0] == b'mutating\n')
        candidate = read_regular('candidate-version', 129, transaction, allowed_owners=owners)[0]
        require(re.fullmatch(rb'[A-Za-z0-9][A-Za-z0-9._-]{0,127}\n', candidate))
        version = candidate.decode('ascii').strip()
        base = os.path.dirname(os.path.dirname(path))
        committed = json.loads(read_regular(os.path.join(base, 'release.json'))[0])
        require(isinstance(committed, dict) and committed.get('version') == version)
        # App files retain the existing owner-admin trust model; root-owned
        # committed release metadata independently anchors the installed version.
        installed = read_regular(os.path.join(base, 'app', 'BUNDLE_VERSION'), 129, root_owned=False)[0]
        require(installed in (candidate, candidate.rstrip(b'\n')))
    finally:
        os.close(transaction)


def completed_funded_repair(path, identity):
    applied = json.loads(read_regular(path, 4096)[0])
    stable_keys = ('handle', 'machineId', 'ownerId', 'runtimeSlot')
    require(isinstance(applied, dict) and set(applied) == {'rolloutId', 'identity', 'afterSha256'}
            and isinstance(applied['rolloutId'], str) and re.fullmatch(r'(?:repair|epoch)-[a-f0-9]{32}', applied['rolloutId'])
            and isinstance(applied['identity'], dict) and set(applied['identity']) == set(stable_keys) | {'epoch'}
            and all(applied['identity'][key] == identity[key] for key in stable_keys)
            and type(applied['identity']['epoch']) is int
            and 1 <= applied['identity']['epoch'] <= identity['runtimeTokenEpoch']
            and isinstance(applied['afterSha256'], str) and re.fullmatch(r'[a-f0-9]{64}', applied['afterSha256']))
    # This is retained rollback history, not a live writer marker. Later speech
    # updates or epoch rotation legitimately change host.env; active maintenance
    # is excluded by the held resume.lock and explicit pending records instead.


def ensure_quiet(markers, identity):
    for marker in markers:
        if not os.path.lexists(marker):
            continue
        if os.path.basename(marker) == 'update-transaction':
            completed_update_transaction(marker)
        elif os.path.basename(marker) == 'applied.json':
            completed_funded_repair(marker, identity)
        else:
            require(False)


def apply_config(env_path, value, markers=MARKERS):
    validate_config(value)
    with maintenance_guards(markers):
        return _apply_config(env_path, value, markers)


def _apply_config(env_path, value, markers):
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
        data, original = read_regular(env_path)
        ensure_quiet(markers, identity)
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
        ensure_quiet(markers, identity)
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

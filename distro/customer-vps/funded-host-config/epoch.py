"""Absent-epoch bootstrap: metadata admission and one atomic complete image.

Concatenated into the verified protected program, never imported from the app.
The standalone four-field repair contract remains unchanged.
"""
import base64

EPOCH_KEY = 'MATRIX_RUNTIME_TOKEN_EPOCH'
EPOCH_FIELDS = {'MATRIX_FUNDED_AI_ENABLED', 'MATRIX_FUNDED_AI_RELAY_URL',
                'MATRIX_FUNDED_AI_RUNTIME_TOKEN', 'MATRIX_FUNDED_AI_PLATFORM_URL', EPOCH_KEY}


def validate_epoch_response(value, expected, source, now):
    require(isinstance(value, dict) and set(value) == {'contractVersion', 'kind', 'source', 'sourceSha',
            'issuedAt', 'expiresAt', 'identity'} and type(value['contractVersion']) is int
            and value['contractVersion'] == 1 and value['kind'] == 'matrix-funded-host-epoch'
            and value['source'] == 'platform' and value['sourceSha'] == source
            and re.fullmatch(r'[a-f0-9]{40}', source))
    identity = value['identity']
    require(isinstance(identity, dict) and set(identity) == set(expected) | {'runtimeTokenEpoch'}
            and all(identity.get(key) == item for key, item in expected.items())
            and type(identity['runtimeTokenEpoch']) is int and 1 <= identity['runtimeTokenEpoch'] <= 2147483647)
    issued, expires = timestamp(value['issuedAt']), timestamp(value['expiresAt'])
    require(issued <= now < expires and 0 < expires - issued <= 30)
    return identity['runtimeTokenEpoch']


def base_host_identity(values):
    expected = {'handle': values.get('MATRIX_HANDLE'), 'machineId': values.get('MATRIX_MACHINE_ID'),
                'ownerId': values.get('MATRIX_CLERK_USER_ID'), 'runtimeSlot': values.get('MATRIX_RUNTIME_SLOT')}
    require(expected['runtimeSlot'] == 'primary'
            and isinstance(expected['ownerId'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', expected['ownerId'])
            and isinstance(expected['handle'], str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{1,62}', expected['handle'])
            and isinstance(expected['machineId'], str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', expected['machineId']))
    return expected


def resolve_host_epoch(values, sync_token, source):
    """No local writes: current scoped Sync bearer proves the DB epoch."""
    expected = base_host_identity(values)
    if EPOCH_KEY in values:
        require(re.fullmatch(r'[1-9][0-9]{0,9}', values[EPOCH_KEY]))
        epoch = int(values[EPOCH_KEY])
        require(epoch <= 2147483647)
        return epoch, None
    response = json_bytes(get('/internal/containers/' + expected['handle'] + '/funded-host-epoch', {
        'Authorization': 'Bearer ' + sync_token, 'x-matrix-machine-id': expected['machineId'],
        'x-matrix-runtime-slot': 'primary'}))
    return validate_epoch_response(response, expected, source, time.time()), (response, expected)


def epoch_sync_token(data):
    tokens = re.findall(rb'^MATRIX_SYNC_RUNTIME_TOKEN=([a-f0-9]{64})$', data, re.MULTILINE)
    assignments = re.findall(rb'^\s*(?:export\s+)?MATRIX_SYNC_RUNTIME_TOKEN\s*=', data, re.MULTILINE)
    require(len(tokens) == 1 and len(assignments) == 1)
    return tokens[0]


def epoch_rollback_image(repair, directory, name, data, values, identity, uid, gid, info):
    """Validate the complete absent-epoch baseline, even after unrelated edits."""
    raw, _ = repair.read_file(directory, name, uid, gid, 0o600, 131072)
    journal = json_bytes(raw)
    require(isinstance(journal, dict) and set(journal) == {'version', 'identity', 'original', 'beforeSha256',
            'afterSha256', 'patch', 'mode', 'uid', 'gid'} and type(journal['version']) is int
            and journal['version'] == 3 and journal['identity'] == identity
            and journal['mode'] == stat.S_IMODE(info.st_mode) and journal['uid'] == info.st_uid
            and journal['gid'] == info.st_gid)
    original = base64.b64decode(journal['original'], validate=True)
    require(len(original) <= repair.LIMIT and digest(original) == journal['beforeSha256'])
    _, before, lines = repair.parse(original)
    require(epoch_sync_token(original) == epoch_sync_token(data))
    require(all(values.get(key) == str(identity[field]) for field, key in repair.IDENTITY.items() if field != 'epoch'))
    require(EPOCH_KEY not in before and all(before.get(key) == str(identity[field])
            for field, key in repair.IDENTITY.items() if field != 'epoch'))
    patch = journal['patch']
    require(isinstance(patch, dict) and set(patch) == EPOCH_FIELDS
            and patch[EPOCH_KEY] == str(identity['epoch']))
    # Reuse the exact funded four-field request contract for patch validation.
    repair.validate({'action': 'apply', 'rolloutId': 'epoch-validation', 'identity': identity,
                    'expectedFile': {'sha256': digest(data), 'inode': info.st_ino, 'device': info.st_dev},
                    'quiescentWindow': True, 'config': {'relayUrl': patch['MATRIX_FUNDED_AI_RELAY_URL'],
                    'platformUrl': patch['MATRIX_FUNDED_AI_PLATFORM_URL'], 'runtimeToken': patch['MATRIX_FUNDED_AI_RUNTIME_TOKEN']}})
    require(patch['MATRIX_FUNDED_AI_ENABLED'] == 'true')
    complete = repair.rewrite(original, {key: key + '=' + value + '\n' for key, value in patch.items()})
    require(digest(complete) == journal['afterSha256'])
    current = {key: values.get(key) for key in patch}
    if current == {key: before.get(key) for key in patch}:
        return data
    require(current == patch)
    return original if digest(data) == journal['afterSha256'] else repair.rewrite(data, {key: lines.get(key) for key in patch})


def execute_epoch_image(repair, anchor, identity, rollout, expected, activity_guard, config=None, uid=0, gid=None):
    """Apply absent epoch + funding or roll back together under one writer lock."""
    gid = grp.getgrnam('matrix').gr_gid if gid is None else gid
    private_gid = 0 if uid == 0 else gid
    validation = {'action': 'rollback', 'rolloutId': rollout, 'identity': identity,
                  'expectedFile': expected, 'quiescentWindow': True}
    repair.validate(validation)
    directory, lock, temporary = anchor.fds[-1], None, None
    created = False
    try:
        lock = os.open('.host.env.funded-repair.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=directory)
        repair.metadata(os.fstat(lock), uid, private_gid, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        activity_guard()
        anchor.verify()
        data, info = repair.read_file(directory, 'host.env', uid, gid)
        repair.verify_expected(data, info, expected)
        _, values, _ = repair.parse(data)
        require(all(values.get(key) == str(identity[field]) for field, key in repair.IDENTITY.items() if field != 'epoch'))
        name = repair.backup_name(rollout)
        if config is None:
            new = epoch_rollback_image(repair, directory, name, data, values, identity, uid, private_gid, info)
        else:
            require(EPOCH_KEY not in values and set(config) == EPOCH_FIELDS - {EPOCH_KEY})
            patch = {**config, EPOCH_KEY: str(identity['epoch'])}
            new = repair.rewrite(data, {key: key + '=' + value + '\n' for key, value in patch.items()})
            require(len(new) <= repair.LIMIT)
            count = total = 0
            with os.scandir(directory) as entries:
                for entry in entries:
                    total += 1
                    count += entry.name.startswith('host.env.funded-') and entry.name.endswith('.json')
                    require(total <= 128 and count < 32)
            journal = {'version': 3, 'identity': identity, 'original': base64.b64encode(data).decode(),
                       'beforeSha256': digest(data), 'afterSha256': digest(new), 'patch': patch,
                       'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
            repair.create_file(directory, name, json.dumps(journal, separators=(',', ':')).encode(), uid, private_gid, 0o600)
            os.fsync(directory)
            # Validate our journal through the exact rollback path before publishing.
            _, new_values, _ = repair.parse(new)
            require(epoch_rollback_image(repair, directory, name, new, new_values, identity, uid, private_gid, info) == data)
        require(len(new) <= repair.LIMIT)
        if new != data:
            temporary = '.host.env.funded.tmp-' + secrets.token_hex(12)
            repair.create_file(directory, temporary, new, uid, gid, 0o640, cleanup=True)
            created = True
            activity_guard()
            anchor.verify()
            current, current_info = repair.read_file(directory, 'host.env', uid, gid)
            require(current == data and repair.fingerprint(current_info) == repair.fingerprint(info))
            os.replace(temporary, 'host.env', src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
            anchor.verify()
        return {'action': 'apply' if config is not None else 'rollback', 'changed': new != data,
                'restartRequired': new != data, 'beforeSha256': digest(data), 'afterSha256': digest(new),
                'backup': name if new != data else None}
    finally:
        if created:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass  # Atomic replacement consumed this invocation's temporary.
        if lock is not None:
            os.close(lock)


def apply_missing_epoch(repair, anchor, identity, config, rollout, data, info, guard, uid=0, gid=None):
    return execute_epoch_image(repair, anchor, identity, rollout,
        {'sha256': digest(data), 'inode': info.st_ino, 'device': info.st_dev}, guard, config, uid, gid)

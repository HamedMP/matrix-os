"""Explicit operator Sync-only enrollment, concatenated into protected bytes.

No rotation, legacy-auth endpoint, service controls or funding/epoch publication.
The operator's authenticated delivery, not encryption alone, authorizes the input.
"""
import base64
import hmac

SYNC_KEY = 'MATRIX_SYNC_RUNTIME_TOKEN'
SYNC_ENVELOPE_NAME = 'sync-initialization.envelope.json'
SYNC_KEY_NAME = 'runtime-token-rotation.pem'


def validate_sync_initialization(value, recipient, now):
    require(isinstance(value, dict) and set(value) == {'contractVersion', 'kind', 'identity', 'expectedRelease',
            'expectedFile', 'recipientSha256', 'issuedAt', 'expiresAt', 'nonce', 'syncRuntimeToken'}
            and type(value['contractVersion']) is int and value['contractVersion'] == 1
            and value['kind'] == 'matrix-sync-initialization')
    identity, release, expected = value['identity'], value['expectedRelease'], value['expectedFile']
    require(isinstance(identity, dict) and set(identity) == {'ownerId', 'handle', 'machineId', 'runtimeSlot', 'runtimeTokenEpoch'}
            and type(identity['runtimeTokenEpoch']) is int and 1 <= identity['runtimeTokenEpoch'] <= 2147483647)
    base_host_identity({'MATRIX_HANDLE': identity['handle'], 'MATRIX_MACHINE_ID': identity['machineId'],
                        'MATRIX_CLERK_USER_ID': identity['ownerId'], 'MATRIX_RUNTIME_SLOT': identity['runtimeSlot']})
    require(isinstance(release, dict) and set(release) == {'version', 'gitCommit'}
            and isinstance(release['version'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', release['version'])
            and isinstance(release['gitCommit'], str) and re.fullmatch(r'[a-f0-9]{40}', release['gitCommit']))
    require(isinstance(expected, dict) and set(expected) == {'sha256', 'inode', 'device'}
            and isinstance(expected['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', expected['sha256'])
            and type(expected['inode']) is int and 0 < expected['inode'] <= 9007199254740991
            and type(expected['device']) is int and 0 <= expected['device'] <= 9007199254740991)
    require(isinstance(recipient, str) and re.fullmatch(r'[a-f0-9]{64}', recipient)
            and isinstance(value['recipientSha256'], str) and hmac.compare_digest(value['recipientSha256'], recipient)
            and isinstance(value['nonce'], str) and re.fullmatch(r'[a-f0-9]{32}', value['nonce'])
            and isinstance(value['syncRuntimeToken'], str) and re.fullmatch(r'[a-f0-9]{64}', value['syncRuntimeToken']))
    issued, expires = timestamp(value['issuedAt']), timestamp(value['expiresAt'])
    require(issued <= now < expires and 0 < expires - issued <= 30)


def sync_initialization_baseline(repair, anchor, value, uid, gid):
    anchor.verify()
    repair.verify_release(anchor, value['expectedRelease'], uid, gid)
    data, info = repair.read_file(anchor.fds[-1], 'host.env', uid, gid)
    repair.verify_expected(data, info, value['expectedFile'])
    _, values, _ = repair.parse(data)
    identity = value['identity']
    require(base_host_identity(values) == {key: identity[key] for key in ('ownerId', 'handle', 'machineId', 'runtimeSlot')})
    # Conservatively reject any non-comment mention rather than normalize shell syntax.
    require(not any(SYNC_KEY.encode() in line for line in data.splitlines() if not line.lstrip().startswith(b'#')))
    if EPOCH_KEY in values:
        require(values[EPOCH_KEY] == str(identity['runtimeTokenEpoch']))
    require(values.get('PLATFORM_INTERNAL_URL') in ('https://app.matrix-os.com', 'https://api.matrix-os.com'))
    relay = values.get('MATRIX_FUNDED_AI_RELAY_URL', '')
    require(not relay or re.fullmatch(r'https://matrix-ai-relay-production-[a-z0-9]+(?:-[a-z0-9]+)?\.a\.run\.app', relay))
    require(values.get('MATRIX_FUNDED_AI_PLATFORM_URL', '') in ('', 'https://app.matrix-os.com'))
    return data, info


def initialize_scoped_sync(repair, anchor, value, recipient, epoch_get, activity_guard, now, uid=0, gid=None):
    """One exclusive journal, original/Sync-only images, no restart or epoch edit."""
    gid = grp.getgrnam('matrix').gr_gid if gid is None else gid
    started = time.monotonic()
    clock = lambda: now + time.monotonic() - started
    validate_sync_initialization(value, recipient, clock())
    lock, temporary, created = None, None, False
    directory = anchor.fds[-1]
    try:
        lock = os.open('.host.env.funded-repair.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=directory)
        repair.metadata(os.fstat(lock), uid, 0 if uid == 0 else gid, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        activity_guard()
        data, info = sync_initialization_baseline(repair, anchor, value, uid, gid)
        identity = value['identity']
        expected_identity = {key: identity[key] for key in ('handle', 'machineId', 'ownerId', 'runtimeSlot')}
        proof = json_bytes(epoch_get('/internal/containers/' + identity['handle'] + '/funded-host-epoch', {
            'Authorization': 'Bearer ' + value['syncRuntimeToken'], 'x-matrix-machine-id': identity['machineId'],
            'x-matrix-runtime-slot': 'primary'}))
        def fresh():
            validate_sync_initialization(value, recipient, clock())
            require(validate_epoch_response(proof, expected_identity, value['expectedRelease']['gitCommit'], clock())
                    == identity['runtimeTokenEpoch'])
        fresh()
        new = repair.rewrite(data, {SYNC_KEY: SYNC_KEY + '=' + value['syncRuntimeToken'] + '\n'})
        require(len(new) <= repair.LIMIT)
        count = total = 0
        with os.scandir(directory) as entries:
            for entry in entries:
                total += 1
                count += entry.name.startswith('.host.env.sync-init-') and entry.name.endswith('.json')
                require(total <= 128 and count < 32)
        journal_name = '.host.env.sync-init-' + value['nonce'] + '.json'
        journal = {'version': 1, 'kind': 'matrix-sync-initialization', 'nonce': value['nonce'],
                   'identity': identity, 'release': value['expectedRelease'], 'recipientSha256': recipient,
                   'original': base64.b64encode(data).decode(), 'beforeSha256': digest(data), 'afterSha256': digest(new),
                   'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
        journal_bytes = json.dumps(journal, separators=(',', ':')).encode()
        require(len(journal_bytes) <= 131072)
        repair.create_file(directory, journal_name, journal_bytes, uid, 0 if uid == 0 else gid, 0o600)
        os.fsync(directory)
        temporary = '.host.env.funded.tmp-' + secrets.token_hex(12)
        repair.create_file(directory, temporary, new, uid, gid, 0o640, cleanup=True)
        created = True
        activity_guard()
        fresh()
        current, current_info = sync_initialization_baseline(repair, anchor, value, uid, gid)
        require(current == data and repair.fingerprint(info) == repair.fingerprint(current_info))
        os.replace(temporary, 'host.env', src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
        anchor.verify()
        repair.verify_release(anchor, value['expectedRelease'], uid, gid)
        return {'changed': True, 'restartRequired': False, 'beforeSha256': digest(data), 'afterSha256': digest(new),
                'backup': journal_name}
    finally:
        if created:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass  # Successful rename consumed this operation's exclusive temp name.
        if lock is not None:
            os.close(lock)


def sync_initialization_rollback_image(repair, directory, name, data, identity, uid=0, gid=0):
    """Recovery image only; refuse a changed token or subsequent funding/epoch work."""
    require(isinstance(name, str) and re.fullmatch(r'\.host\.env\.sync-init-[a-f0-9]{32}\.json', name))
    raw, _ = repair.read_file(directory, name, uid, 0 if uid == 0 else gid, 0o600, 131072)
    journal = json_bytes(raw)
    require(isinstance(journal, dict) and set(journal) == {'version', 'kind', 'nonce', 'identity', 'release',
            'recipientSha256', 'original', 'beforeSha256', 'afterSha256', 'mode', 'uid', 'gid'}
            and type(journal['version']) is int and journal['version'] == 1
            and journal['kind'] == 'matrix-sync-initialization' and journal['identity'] == identity
            and journal['mode'] == 0o640 and journal['uid'] == uid and journal['gid'] == gid
            and re.fullmatch(r'[a-f0-9]{32}', journal['nonce'])
            and name == '.host.env.sync-init-' + journal['nonce'] + '.json')
    original = base64.b64decode(journal['original'], validate=True)
    require(len(original) <= repair.LIMIT and digest(original) == journal['beforeSha256'])
    _, before, _ = repair.parse(original)
    _, current, _ = repair.parse(data)
    expected_identity = {key: identity[key] for key in ('ownerId', 'handle', 'machineId', 'runtimeSlot')}
    require(base_host_identity(before) == expected_identity and base_host_identity(current) == expected_identity
            and not any(SYNC_KEY.encode() in line for line in original.splitlines() if not line.lstrip().startswith(b'#'))
            and all(before.get(key) == current.get(key) for key in EPOCH_FIELDS))
    token = epoch_sync_token(data).decode()
    expected = repair.rewrite(original, {SYNC_KEY: SYNC_KEY + '=' + token + '\n'})
    require(digest(expected) == journal['afterSha256'])
    result = original if digest(data) == journal['afterSha256'] else repair.rewrite(data, {SYNC_KEY: None})
    require(len(result) <= repair.LIMIT)
    return result


def read_sync_initialization_inputs(repair, state, anchor, uid=0):
    """Pinned root-private input/key reads; no key material comes from argv."""
    anchor.verify()
    state.verify()
    private_gid = 0 if uid == 0 else anchor.gid
    encrypted, _ = repair.read_file(state.fds[-1], SYNC_ENVELOPE_NAME, uid, private_gid, 0o600, 32768)
    key, _ = repair.read_file(anchor.fds[-1], SYNC_KEY_NAME, uid, private_gid, 0o600, 8192)
    anchor.verify()
    state.verify()
    return encrypted, key


def decrypt_sync_initialization(encrypted, key_bytes):
    """Crypto imports stay off the portable core and unchanged maintenance path."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    require(isinstance(encrypted, bytes) and len(encrypted) <= 32768
            and isinstance(key_bytes, bytes) and len(key_bytes) <= 8192)
    envelope = json_bytes(encrypted)
    require(isinstance(envelope, dict) and set(envelope) == {'version', 'encryptedKey', 'nonce', 'ciphertext', 'tag'}
            and type(envelope['version']) is int and envelope['version'] == 2)
    def decode(name, maximum):
        value = envelope[name]
        require(isinstance(value, str) and len(value) <= maximum and re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', value))
        return base64.b64decode(value, validate=True)
    private = serialization.load_pem_private_key(key_bytes, password=None)
    require(isinstance(private, rsa.RSAPrivateKey) and private.key_size >= 2048)
    key = private.decrypt(decode('encryptedKey', 2048), padding.OAEP(
        mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    nonce, tag, ciphertext = decode('nonce', 32), decode('tag', 32), decode('ciphertext', 16384)
    require(len(key) == 32 and len(nonce) == 12 and len(tag) == 16 and len(ciphertext) <= 8192)
    payload = AESGCM(key).decrypt(nonce, ciphertext + tag, None)
    require(len(payload) <= 8192)
    public = private.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return json_bytes(payload), digest(public)


def sync_initialization_guard(repair, anchor, receipt, state, lib, units):
    """Focused writer exclusion; an idle Sync daemon may remain active."""
    anchor.verify()
    require(json_bytes(state.read('receipt.json')) == receipt
            and digest(lib.read('matrix-funded-host-config.py')) == receipt['componentSha256']
            and digest(units.read('matrix-funded-host-config.service')) == receipt['unitSha256'])
    for name in ('install-pending.json', 'invocation.json', 'resume.json', 'applied.json'):
        require(not os.path.lexists('/var/lib/matrix-funded-host-config/' + name))
    repair.verify_release(anchor, {'version': receipt['version'], 'gitCommit': receipt['sourceSha']}, 0, anchor.gid)
    verify_installed_bundle(receipt['version'])
    for path in ('/opt/matrix/app/.update-now', '/opt/matrix/app/.update-repair-now',
                 '/opt/matrix/app/.rollback-now', '/opt/matrix/staging/update-phase'):
        require(not os.path.lexists(path))
    transaction = '/opt/matrix/staging/update-transaction'
    if os.path.lexists(transaction):
        fd = os.open(transaction, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            require(info.st_uid == 0 and not info.st_mode & 0o022)
            for name, expected in (('state', b'mutating\n'), ('candidate-version', (receipt['version'] + '\n').encode())):
                require(repair.read_file(fd, name, 0, 0, 0o644, 256)[0] == expected)
        finally:
            os.close(fd)
    with os.scandir('/proc') as entries:
        count = 0
        for entry in entries:
            if not entry.name.isdigit() or int(entry.name) == os.getpid():
                continue
            count += 1
            require(count <= 8192)
            try:
                with open(entry.path + '/cmdline', 'rb') as stream:
                    names = {os.path.basename(arg) for arg in stream.read(8192).split(b'\x00')}
            except (FileNotFoundError, ProcessLookupError):
                continue
            require(not names & {b'matrix-update', b'cloud-init', b'matrix-configure-platform-speech.py',
                                 b'matrix-rotate-runtime-tokens.py'})


def sync_initialization_entry():
    """Fixed root-private envelope/key, exact verified source, explicit invocation."""
    require(os.geteuid() == 0)
    state = Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
    lib = Directory('/', ('usr', 'local', 'libexec'))
    units = Directory('/', ('etc', 'systemd', 'system'))
    anchor, lock = None, None
    try:
        require(stat.S_IMODE(os.fstat(state.fds[-1]).st_mode) == 0o700)
        lock = maintenance_lock(state)
        receipt = json_bytes(state.read('receipt.json'))
        require(isinstance(receipt, dict) and set(receipt) == {'version', 'sourceSha', 'archiveSha256', 'componentSha256', 'unitSha256'}
                and isinstance(receipt['version'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', receipt['version'])
                and isinstance(receipt['sourceSha'], str) and re.fullmatch(r'[a-f0-9]{40}', receipt['sourceSha'])
                and all(isinstance(receipt[key], str) and re.fullmatch(r'[a-f0-9]{64}', receipt[key]) for key in
                        ('archiveSha256', 'componentSha256', 'unitSha256')))
        namespace = {'__name__': 'protected_sync_repair'}
        exec(compile(REPAIR_SOURCE, '<protected-repair>', 'exec'), namespace)
        repair = type('Repair', (), namespace)
        gid = grp.getgrnam('matrix').gr_gid
        anchor = repair.open_environment('/', 0, gid)
        guard = lambda: sync_initialization_guard(repair, anchor, receipt, state, lib, units)
        guard()
        encrypted, key = read_sync_initialization_inputs(repair, state, anchor)
        value, recipient = decrypt_sync_initialization(encrypted, key)
        require(value.get('expectedRelease') == {'version': receipt['version'], 'gitCommit': receipt['sourceSha']})
        result = initialize_scoped_sync(repair, anchor, value, recipient, get, guard, time.time(), 0, gid)
        print(json.dumps(result))  # Hashes/receipt filename only; no envelope or credential.
    finally:
        if lock is not None:
            os.close(lock)
        if anchor is not None:
            anchor.close()
        units.close()
        lib.close()
        state.close()

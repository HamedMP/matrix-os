"""Protected updater recovery proof and explicit legacy speech reseal.

Normal proofs are read-only. The operator entrypoint moves only speech lines
and rebases complete rollback records; neither path imports mutable app code.
"""

SPEECH_KEYS = {'MATRIX_PLATFORM_SPEECH_ENABLED', 'MATRIX_PLATFORM_SPEECH_ORIGIN',
               'MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN'}


def speech_values(data, optional=False):
    """Accept only the speech writer's complete, literal three-field contract."""
    require(len(data) <= 65536 and b'\x00' not in data and b'\r' not in data)
    values = {}
    for line in data.decode('utf-8').split('\n'):
        match = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=', line)
        if match and match[1] in SPEECH_KEYS:
            key = match[1]
            require(key not in values and line.startswith(key + '='))
            values[key] = line[len(key) + 1:]
    if optional and not values:
        return values
    require(set(values) == SPEECH_KEYS and values['MATRIX_PLATFORM_SPEECH_ENABLED'] in (('true', 'false') if optional else ('true',))
            and re.fullmatch(r'[a-f0-9]{64}', values['MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN']))
    origin = values['MATRIX_PLATFORM_SPEECH_ORIGIN']
    require(1 <= len(origin) <= 512 and re.fullmatch(r'[A-Za-z0-9_./:~-]+', origin))
    parsed = urlsplit(origin)
    require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment and parsed.path in ('', '/'))
    # Force port parsing too: malformed/out-of-range ports are never proof.
    parsed.port
    return values


def speech_image(data, values):
    """Reproduce the serialized speech writer without changing other bytes."""
    lines, found = data.decode('utf-8').split('\n'), set()
    for index, line in enumerate(lines):
        key = line.split('=', 1)[0]
        if key in values:
            lines[index] = key + '=' + values[key]
            found.add(key)
    insertion = len(lines) - 1 if lines and lines[-1] == '' else len(lines)
    for key in sorted(set(values) - found):
        lines.insert(insertion, key + '=' + values[key])
        insertion += 1
    result = '\n'.join(lines).encode('utf-8')
    require(len(result) <= 65536)
    return result


def funded_recovery_image(repair, directory, data, info, applied, journal):
    """Verify the complete sealed baseline before allowing independent speech."""
    require(set(applied) == {'rolloutId', 'identity', 'afterSha256'}
            and journal.get('afterSha256') == applied['afterSha256'])
    _, values, _ = repair.parse(data)
    request = {'action': 'rollback', 'rolloutId': applied['rolloutId'], 'identity': applied['identity'],
               'expectedFile': {'sha256': digest(data), 'inode': info.st_ino, 'device': info.st_dev},
               'quiescentWindow': True}
    repair.validate(request)
    repair.verify_identity(values, applied['identity'])
    name = repair.backup_name(applied['rolloutId'])
    if re.fullmatch(r'epoch-[a-f0-9]{32}', applied['rolloutId']):
        epoch_rollback_image(repair, directory, name, data, values, applied['identity'], 0, 0, info)
    else:
        repair.rollback_image(directory, name, data, values, applied['identity'], 0, 0, info)
    original = base64.b64decode(journal['original'], validate=True)
    sealed = repair.rewrite(original, {key: key + '=' + value + '\n' for key, value in journal['patch'].items()})
    require(digest(sealed) == applied['afterSha256'])
    if data != sealed:
        speech_values(sealed, optional=True)
        require(speech_image(sealed, speech_values(data)) == data)
    return original


def rebased_speech_record(repair, data, applied, journal):
    """Rebase only independent speech bytes in the complete rollback original."""
    original = base64.b64decode(journal['original'], validate=True)
    require(len(original) <= repair.LIMIT and digest(original) == journal['beforeSha256'])
    sealed = repair.rewrite(original, {key: key + '=' + value + '\n' for key, value in journal['patch'].items()})
    require(digest(sealed) == journal['afterSha256'] == applied['afterSha256'])
    speech_values(sealed, optional=True)
    values = speech_values(data)
    before = speech_image(sealed, values)
    original = speech_image(original, values)
    after = repair.rewrite(original, {key: key + '=' + value + '\n' for key, value in journal['patch'].items()})
    require(data in (before, after))
    without_speech = lambda image: b''.join(line for line in image.splitlines(keepends=True)
            if line.split(b'=', 1)[0].decode('utf-8') not in SPEECH_KEYS)
    require(without_speech(before) == without_speech(after))
    return (dict(applied, afterSha256=digest(after)), dict(journal, original=base64.b64encode(original).decode(),
            beforeSha256=digest(original), afterSha256=digest(after)), before, after)


def reseal_speech_record(repair, anchor, state, receipt, data, info, applied, journal, request, commit):
    """Explicit root-only migration; moves only the three speech assignments."""
    require(isinstance(request, dict) and set(request) == {'receiptSha256', 'expectedFile', 'quiescentWindow'}
            and request['quiescentWindow'] is True and isinstance(request['receiptSha256'], str)
            and re.fullmatch(r'[a-f0-9]{64}', request['receiptSha256'])
            and digest(state.read('receipt.json')) == request['receiptSha256'])
    # Reuse the protected repair's bounded exact-file guard validation.
    repair.validate({'action': 'rollback', 'rolloutId': applied['rolloutId'], 'identity': applied['identity'],
                    'expectedFile': request['expectedFile'], 'quiescentWindow': True})
    repair.verify_expected(data, info, request['expectedFile'])
    require(not os.path.lexists('/opt/matrix/staging/update-phase')
            and not os.path.lexists('/opt/matrix/staging/update-transaction'))
    for path in ('/opt/matrix/app/.update-now', '/opt/matrix/app/.update-repair-now',
                 '/opt/matrix/app/.rollback-now', '/opt/matrix/env/runtime-token-rotation.pending'):
        require(not os.path.lexists(path))
    verify_recovery_app(receipt['version'], '/opt/matrix/app', None)
    pending_name = 'speech-reseal-pending.json'
    try:
        pending = json_bytes(state.read(pending_name, 524288))
    except FileNotFoundError:
        pending = None
    if pending is not None:
        require(isinstance(pending, dict) and set(pending) == {'receipt', 'beforeHostSha256', 'afterHostSha256', 'beforeApplied',
                'beforeJournal', 'afterApplied', 'afterJournal'} and pending['receipt'] == receipt
                and digest(data) in (pending['beforeHostSha256'], pending['afterHostSha256'])
                and applied in (pending['beforeApplied'], pending['afterApplied'])
                and journal in (pending['beforeJournal'], pending['afterJournal']))
        after_applied, after_journal, before_data, after_data = rebased_speech_record(
            repair, data, pending['beforeApplied'], pending['beforeJournal'])
        matching = pending['beforeApplied'] if journal == pending['beforeJournal'] else pending['afterApplied']
        validation_data = before_data if journal == pending['beforeJournal'] else after_data
        funded_recovery_image(repair, anchor.fds[-1], validation_data, info, matching, journal)
        require(after_applied == pending['afterApplied'] and after_journal == pending['afterJournal']
                and digest(before_data) == pending['beforeHostSha256']
                and digest(after_data) == pending['afterHostSha256'])
    else:
        funded_recovery_image(repair, anchor.fds[-1], data, info, applied, journal)
        if applied['afterSha256'] == digest(data):
            print('{"action":"reseal-speech","changed":false}')
            return
        after_applied, after_journal, before_data, after_data = rebased_speech_record(repair, data, applied, journal)
        pending = {'receipt': receipt, 'beforeHostSha256': digest(before_data), 'afterHostSha256': digest(after_data), 'beforeApplied': applied,
                   'beforeJournal': journal, 'afterApplied': after_applied, 'afterJournal': after_journal}
    raw = json.dumps(after_journal, separators=(',', ':')).encode()
    require(len(raw) <= 131072 and len(after_data) <= repair.LIMIT)
    if commit:
        anchor.verify()
        current_data, current_info = repair.read_file(anchor.fds[-1], 'host.env', 0, info.st_gid)
        repair.verify_expected(current_data, current_info, request['expectedFile'])
        require(json_bytes(state.read('receipt.json')) == receipt)
        state.write(pending_name, json.dumps(pending, separators=(',', ':')).encode(), 0o600)
        # A durable intent precedes all three replacements. A crash leaves either
        # valid pair or a mismatch that the legacy verifier rejects. Re-run this
        # procedure only with fresh guards; it validates and rolls forward.
        name = repair.backup_name(after_applied['rolloutId'])
        temporary = '.host.env.speech-reseal-' + secrets.token_hex(12)
        repair.create_file(anchor.fds[-1], temporary, raw, 0, 0, 0o600, cleanup=True)
        try:
            anchor.verify()
            os.replace(temporary, name, src_dir_fd=anchor.fds[-1], dst_dir_fd=anchor.fds[-1])
            os.fsync(anchor.fds[-1])
        finally:
            try:
                os.unlink(temporary, dir_fd=anchor.fds[-1])
            except FileNotFoundError:
                pass  # Atomic replacement consumed this invocation's file.
        if data != after_data:
            temporary = '.host.env.speech-reseal-' + secrets.token_hex(12)
            repair.create_file(anchor.fds[-1], temporary, after_data, 0, info.st_gid, stat.S_IMODE(info.st_mode), cleanup=True)
            try:
                anchor.verify()
                current_data, current_info = repair.read_file(anchor.fds[-1], 'host.env', 0, info.st_gid)
                repair.verify_expected(current_data, current_info, request['expectedFile'])
                os.replace(temporary, 'host.env', src_dir_fd=anchor.fds[-1], dst_dir_fd=anchor.fds[-1])
                os.fsync(anchor.fds[-1])
            finally:
                try:
                    os.unlink(temporary, dir_fd=anchor.fds[-1])
                except FileNotFoundError:
                    pass  # Atomic replacement consumed this invocation's file.
        state.write('applied.json', json.dumps(after_applied, separators=(',', ':')).encode(), 0o600)
        anchor.verify()
        current_data, current_info = repair.read_file(anchor.fds[-1], 'host.env', 0, info.st_gid)
        require(current_data == after_data)
        funded_recovery_image(repair, anchor.fds[-1], current_data, current_info, after_applied, after_journal)
        release_gid = os.stat('release.json', dir_fd=anchor.fds[-2], follow_symlinks=False).st_gid
        require(release_gid in (0, info.st_gid))
        release = json_bytes(repair.read_file(anchor.fds[-2], 'release.json', 0, release_gid, 0o644)[0])
        require(release.get('version') == receipt['version'] and release.get('gitCommit') == receipt['sourceSha']
                and json_bytes(state.read('receipt.json')) == receipt)
        state.write('speech-reseal-receipt.json', json.dumps({'receipt': receipt,
                    'baselineSha256': pending['beforeApplied']['afterSha256'],
                    'beforeSha256': pending['beforeHostSha256'], 'afterSha256': digest(after_data)},
                    separators=(',', ':')).encode(), 0o600)
        os.unlink(pending_name, dir_fd=state.fds[-1])
        os.fsync(state.fds[-1])
    print(json.dumps({'action': 'reseal-speech', 'changed': True, 'committed': commit}))


def same_version_artifact_proof(receipt, repair, state, staging, transaction, install_lock):
    """An explicit sealed reinstall, not a same-name version assertion."""
    pin = json_bytes(repair.read_file(transaction, 'same-version-repair.json', 0, 0, 0o644)[0])
    require(set(pin) == {'kind', 'contractVersion', 'receipt', 'appDevice', 'appInode'}
            and pin['kind'] == 'matrix-same-version-artifact-repair'
            and type(pin['contractVersion']) is int and pin['contractVersion'] == 1 and pin['receipt'] == receipt
            and type(pin['appDevice']) is int and 0 <= pin['appDevice'] < 2 ** 64
            and type(pin['appInode']) is int and 0 < pin['appInode'] < 2 ** 64)
    # Serialize the bounded protected snapshot against installs/other proofs.
    fcntl.flock(install_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    source, copy, name = None, None, None
    try:
        source = os.open('bundle-' + receipt['version'] + '.tar.gz', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=staging)
        meta = validate_metadata({'version': receipt['version'], 'gitCommit': receipt['sourceSha'],
                                  'size': os.fstat(source).st_size, 'sha256': receipt['archiveSha256']},
                                 receipt['version'], receipt['sourceSha'])
        space = os.fstatvfs(state.fds[-1])
        require(space.f_bavail * space.f_frsize >= meta['size'] + 128 * 1024 ** 2)
        # Crash remnants defer instead of growing an unbounded archive set.
        require(not any(value.startswith('.archive-') for value in os.listdir(state.fds[-1])))
        name = '.archive-repair-' + secrets.token_hex(12)
        copy = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=state.fds[-1])
        # Hold the descriptor only; ordinary exit or process death frees storage.
        os.unlink(name, dir_fd=state.fds[-1])
        name = None
        snapshot(source, copy, meta)
        contents = payload(copy)
        require(digest(contents['funded-host-config/reconcile.py']) == receipt['componentSha256']
                and digest(contents['funded-host-config/matrix-funded-host-config.service']) == receipt['unitSha256'])
        return pin
    finally:
        for fd in (source, copy):
            if fd is not None:
                os.close(fd)
        if name is not None:
            os.unlink(name, dir_fd=state.fds[-1])


def verify_recovery_app(version, directory, pin):
    if pin is not None:
        info = os.stat(directory, follow_symlinks=False)
        require(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == (pin['appDevice'], pin['appInode']))
    verify_installed_bundle(version, directory)
    if pin is not None:
        after = os.stat(directory, follow_symlinks=False)
        require((after.st_dev, after.st_ino) == (pin['appDevice'], pin['appInode']))


def recovery_proof(preflight=False, reseal=None, commit=False):
    """Read-only recovery to the committed config owner, never field rollback.

    The caller's automatic flag is insufficient: an actual sealed uncommitted
    transaction, unchanged complete journal and matching app are mandatory.
    """
    require(os.geteuid() == 0 and (reseal is not None or not commit))
    state = Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
    lib = Directory('/', ('usr', 'local', 'libexec'))
    units = Directory('/', ('etc', 'systemd', 'system'))
    anchor, transaction, staging, install_lock, env_lock, maintenance = None, None, None, None, None, None
    try:
        if reseal is not None:
            # Even --check must not create a new lock/state file.
            maintenance = os.open('resume.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=state.fds[-1])
            minfo = os.fstat(maintenance)
            require(stat.S_ISREG(minfo.st_mode) and minfo.st_uid == 0 and minfo.st_gid == 0
                    and minfo.st_nlink == 1 and stat.S_IMODE(minfo.st_mode) == 0o600)
            fcntl.flock(maintenance, fcntl.LOCK_EX | fcntl.LOCK_NB)
        install_lock = os.open('install.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=state.fds[-1])
        require(stat.S_ISREG(os.fstat(install_lock).st_mode) and os.fstat(install_lock).st_uid == 0
                and os.fstat(install_lock).st_nlink == 1 and not os.fstat(install_lock).st_mode & 0o022)
        fcntl.flock(install_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        receipt = json_bytes(state.read('receipt.json'))
        require(set(receipt) == {'version', 'sourceSha', 'archiveSha256', 'componentSha256', 'unitSha256'}
                and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', receipt['version'])
                and re.fullmatch(r'[a-f0-9]{40}', receipt['sourceSha'])
                and all(re.fullmatch(r'[a-f0-9]{64}', receipt[key]) for key in
                        ('archiveSha256', 'componentSha256', 'unitSha256'))
                and digest(lib.read('matrix-funded-host-config.py')) == receipt['componentSha256']
                and digest(units.read('matrix-funded-host-config.service')) == receipt['unitSha256'])
        for name in ('install-pending.json', 'invocation.json', 'resume.json'):
            require(not os.path.lexists('/var/lib/matrix-funded-host-config/' + name))
        if reseal is None:
            require(not os.path.lexists('/var/lib/matrix-funded-host-config/speech-reseal-pending.json'))
        repair = type('Repair', (), {})()
        namespace = {'__name__': 'protected_repair'}
        exec(compile(REPAIR_SOURCE, '<protected-repair>', 'exec'), namespace)
        for name, value in namespace.items():
            setattr(repair, name, value)
        gid = grp.getgrnam('matrix').gr_gid
        anchor = repair.open_environment('/', 0, gid)
        env_lock = os.open('.host.env.funded-repair.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                           dir_fd=anchor.fds[-1])
        repair.metadata(os.fstat(env_lock), 0, 0, 0o600)
        fcntl.flock(env_lock, (fcntl.LOCK_EX if reseal is not None else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        # Current updater commits root:matrix metadata; older installation paths
        # may use root:root. Both must remain nonwritable regular single links.
        release_gid = os.stat('release.json', dir_fd=anchor.fds[-2], follow_symlinks=False).st_gid
        require(release_gid in (0, gid))
        current = json_bytes(repair.read_file(anchor.fds[-2], 'release.json', 0, release_gid, 0o644)[0])
        require(current.get('version') == receipt['version'] and current.get('gitCommit') == receipt['sourceSha'])
        data, info = repair.read_file(anchor.fds[-1], 'host.env', 0, gid)
        applied = json_bytes(state.read('applied.json'))
        require(isinstance(applied, dict) and set(applied) == {'rolloutId', 'identity', 'afterSha256'})
        repair.validate({'action': 'rollback', 'rolloutId': applied['rolloutId'], 'identity': applied['identity'],
                        'expectedFile': {'sha256': digest(data), 'inode': info.st_ino, 'device': info.st_dev},
                        'quiescentWindow': True})
        journal_name = repair.backup_name(applied['rolloutId'])
        journal = json_bytes(repair.read_file(anchor.fds[-1], journal_name, 0, 0, 0o600, 131072)[0])
        if reseal is not None:
            reseal_speech_record(repair, anchor, state, receipt, data, info, applied, journal, reseal, commit)
            return
        # Validate complete original bytes, patch, identity and post-image without
        # executing a rollback or changing either journal or environment.
        funded_recovery_image(repair, anchor.fds[-1], data, info, applied, journal)
        staging = os.open('staging', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=anchor.fds[-2])
        # The phase is an updater-owned bounded hint; authority comes from the
        # root-sealed transaction and committed receipt, not this mutable hint.
        pinfo = os.stat('update-phase', dir_fd=staging, follow_symlinks=False)
        require(stat.S_IMODE(pinfo.st_mode) in (0o600, 0o644))
        phase, _ = repair.read_file(staging, 'update-phase', pinfo.st_uid, pinfo.st_gid,
                                    stat.S_IMODE(pinfo.st_mode), 64)
        require(phase.strip() in (b'prepare', b'download', b'verify', b'extract', b'terminal-runtime',
                                 b'app-install', b'host-bin', b'health'))
        transaction = os.open('update-transaction', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=staging)
        tinfo = os.fstat(transaction)
        require(tinfo.st_uid == 0 and tinfo.st_gid == 0 and not tinfo.st_mode & 0o022)
        status = repair.read_file(transaction, 'state', 0, 0, 0o644, 64)[0]
        require(status in (b'prepared\n', b'mutating\n'))
        candidate = repair.read_file(transaction, 'candidate-version', 0, 0, 0o644, 129)[0]
        require(re.fullmatch(rb'[A-Za-z0-9][A-Za-z0-9._-]{0,127}\n', candidate))
        saved = json_bytes(repair.read_file(transaction, 'release-metadata', 0, 0, 0o644)[0])
        require(saved == current)
        same_repair = None
        if candidate.strip().decode() == receipt['version']:
            same_repair = same_version_artifact_proof(receipt, repair, state, staging, transaction, install_lock)
        # Prefer current app: handles pre-swap failure and interrupted recovery
        # after the app was already restored. A stale older .rollback is ignored.
        try:
            verify_recovery_app(receipt['version'], '/opt/matrix/app', same_repair)
            target = 'current'
        except (OSError, ConfigError):
            require(not preflight)
            verify_recovery_app(receipt['version'], '/opt/matrix/app.rollback', same_repair)
            target = 'rollback'
        anchor.verify()
        state.verify()
        require(repair.read_file(anchor.fds[-1], 'host.env', 0, gid)[0] == data)
        require(json_bytes(state.read('receipt.json')) == receipt
                and json_bytes(repair.read_file(anchor.fds[-2], 'release.json', 0, release_gid, 0o644)[0]) == current)
        print(target)
    finally:
        for fd in (transaction, staging, install_lock, env_lock, maintenance):
            if fd is not None:
                os.close(fd)
        if anchor is not None:
            anchor.close()
        units.close()
        lib.close()
        state.close()

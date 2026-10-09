"""Read-only sealed updater recovery proof, concatenated into protected code.

Never imports mutable app code, changes funded fields or discards journals.
"""


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


def recovery_proof(preflight=False):
    """Read-only recovery to the committed config owner, never field rollback.

    The caller's automatic flag is insufficient: an actual sealed uncommitted
    transaction, unchanged complete journal and matching app are mandatory.
    """
    require(os.geteuid() == 0)
    state = Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
    lib = Directory('/', ('usr', 'local', 'libexec'))
    units = Directory('/', ('etc', 'systemd', 'system'))
    anchor, transaction, staging, install_lock, env_lock = None, None, None, None, None
    try:
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
        fcntl.flock(env_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        # Current updater commits root:matrix metadata; older installation paths
        # may use root:root. Both must remain nonwritable regular single links.
        release_gid = os.stat('release.json', dir_fd=anchor.fds[-2], follow_symlinks=False).st_gid
        require(release_gid in (0, gid))
        current = json_bytes(repair.read_file(anchor.fds[-2], 'release.json', 0, release_gid, 0o644)[0])
        require(current.get('version') == receipt['version'] and current.get('gitCommit') == receipt['sourceSha'])
        data, info = repair.read_file(anchor.fds[-1], 'host.env', 0, gid)
        _, values, _ = repair.parse(data)
        applied = json_bytes(state.read('applied.json'))
        require(set(applied) == {'rolloutId', 'identity', 'afterSha256'} and applied['afterSha256'] == digest(data))
        request = {'action': 'rollback', 'rolloutId': applied['rolloutId'], 'identity': applied['identity'],
                   'expectedFile': {'sha256': digest(data), 'inode': info.st_ino, 'device': info.st_dev},
                   'quiescentWindow': True}
        repair.validate(request)
        repair.verify_identity(values, applied['identity'])
        journal_name = repair.backup_name(applied['rolloutId'])
        journal = json_bytes(repair.read_file(anchor.fds[-1], journal_name, 0, 0, 0o600, 131072)[0])
        require(journal.get('afterSha256') == applied['afterSha256'])
        # Validate complete original bytes, patch, identity and post-image without
        # executing a rollback or changing either journal or environment.
        repair.rollback_image(anchor.fds[-1], journal_name, data, values, applied['identity'], 0, 0, info)
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
        for fd in (transaction, staging, install_lock, env_lock):
            if fd is not None:
                os.close(fd)
        if anchor is not None:
            anchor.close()
        units.close()
        lib.close()
        state.close()

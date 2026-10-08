"""Concatenated with install.py and the reviewed repair primitive at build time.

Only the updater's explicit coordinated maintenance window may invoke this.
No timer, automatic service stop, owner data read, inference or money mutation.
"""
import datetime
import grp
import subprocess
import sys

SERVICES = ('matrix-gateway.service', 'matrix-shell.service', 'matrix-terminal-runtime.service',
            'matrix-scope-runtime.service', 'matrix-symphony.service', 'matrix-sync-agent.service')
OPTIONAL_SERVICES = {'matrix-terminal-runtime.service', 'matrix-scope-runtime.service', 'matrix-symphony.service'}


def timestamp(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value))
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def validate_response(value, identity, source, now):
    require(isinstance(value, dict) and set(value) == {'contractVersion', 'kind', 'source', 'sourceSha',
            'issuedAt', 'expiresAt', 'identity', 'configuration'} and type(value['contractVersion']) is int
            and value['contractVersion'] == 1 and value['kind'] == 'matrix-funded-host-config'
            and value['source'] == 'platform' and value['sourceSha'] == source
            and re.fullmatch(r'[a-f0-9]{40}', source) and value['identity'] == identity
            and type(value['identity']['runtimeTokenEpoch']) is int)
    issued, expires = timestamp(value['issuedAt']), timestamp(value['expiresAt'])
    require(issued <= now < expires and 0 < expires - issued <= 30)
    config = value['configuration']
    require(isinstance(config, dict) and set(config) == {'MATRIX_FUNDED_AI_ENABLED', 'MATRIX_FUNDED_AI_RELAY_URL',
            'MATRIX_FUNDED_AI_RUNTIME_TOKEN', 'MATRIX_FUNDED_AI_PLATFORM_URL'}
            and config['MATRIX_FUNDED_AI_ENABLED'] == 'true' and config['MATRIX_FUNDED_AI_PLATFORM_URL'] == 'https://app.matrix-os.com'
            and isinstance(config['MATRIX_FUNDED_AI_RUNTIME_TOKEN'], str)
            and re.fullmatch(r'[a-f0-9]{64}', config['MATRIX_FUNDED_AI_RUNTIME_TOKEN'])
            and isinstance(config['MATRIX_FUNDED_AI_RELAY_URL'], str)
            and re.fullmatch(r'https://matrix-ai-relay-production-[a-z0-9]+(?:-[a-z0-9]+)?\.a\.run\.app', config['MATRIX_FUNDED_AI_RELAY_URL']))
    return config


def systemctl(*args):
    result = subprocess.run(['/usr/bin/systemctl', *args], stdin=subprocess.DEVNULL,
                            capture_output=True, timeout=10, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    return result.returncode, result.stdout.decode('utf-8').strip()


def verify_installed_bundle(version):
    fd = os.open('/opt/matrix/app/BUNDLE_VERSION', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        # The app tree belongs to matrix under the inherited owner-admin model.
        # This is a consistency guard, not an independently trusted receipt.
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= 129)
        data = os.read(fd, 130)
        after = os.fstat(fd)
        current = os.stat('/opt/matrix/app/BUNDLE_VERSION', follow_symlinks=False)
        require(data in (version.encode(), (version + '\n').encode())
                and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                and (current.st_dev, current.st_ino) == (before.st_dev, before.st_ino))
    finally:
        os.close(fd)


def activity(repair, version):
    verify_installed_bundle(version)
    # The updater owns the coordinated window; it must stop itself separately
    # via the oneshot dispatch described in the integration contract.
    for service in SERVICES:
        _, load = systemctl('show', '--property=LoadState', '--value', service)
        if service in OPTIONAL_SERVICES and load == 'not-found':
            continue
        require(load == 'loaded')
        _, state = systemctl('is-active', service)
        require(state in ('inactive', 'failed'))
    for path in ('/opt/matrix/app/.update-now', '/opt/matrix/app/.update-repair-now',
                 '/opt/matrix/app/.rollback-now', '/opt/matrix/staging/update-phase'):
        require(not os.path.lexists(path))
    transaction = '/opt/matrix/staging/update-transaction'
    if os.path.lexists(transaction):
        fd = os.open(transaction, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            require(info.st_uid == 0 and not info.st_mode & 0o022)
            for name, expected in (('state', b'mutating\n'), ('candidate-version', (version + '\n').encode())):
                data, _ = repair.read_file(fd, name, 0, 0, 0o644, 256)
                require(data == expected)
        finally:
            os.close(fd)
    # Reuse process writer checks, excluding only the already validated completed
    # transaction state. No blanket ignore of active transaction/phase markers.
    with os.scandir('/proc') as entries:
        count = 0
        for entry in entries:
            if not entry.name.isdigit() or int(entry.name) == os.getpid():
                continue
            count += 1
            require(count <= 8192)
            try:
                with open(entry.path + '/cmdline', 'rb') as file:
                    names = {os.path.basename(arg) for arg in file.read(8192).split(b'\x00')}
            except (FileNotFoundError, ProcessLookupError):
                continue
            require(not names & {b'matrix-sync-agent', b'matrix-update', b'cloud-init',
                    b'matrix-configure-platform-speech.py', b'matrix-rotate-runtime-tokens.py',
                    b'claude', b'codex', b'pi', b'opencode'})


def run(action='apply'):
    require(os.geteuid() == 0 and action in ('apply', 'rollback', 'admit', 'admit-stopped', 'inspect'))
    state = Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
    lib = Directory('/', ('usr', 'local', 'libexec'))
    anchor = None
    try:
        receipt = json_bytes(state.read('receipt.json'))
        require(set(receipt) == {'version', 'sourceSha', 'archiveSha256', 'componentSha256', 'unitSha256'}
                and digest(lib.read('matrix-funded-host-config.py')) == receipt['componentSha256'])
        verify_installed_bundle(receipt['version'])
        # Embedded reviewed bytes are part of the independently verified archive.
        repair = type('Repair', (), {})()
        namespace = {'__name__': 'protected_repair'}
        exec(compile(REPAIR_SOURCE, '<protected-repair>', 'exec'), namespace)
        for name, value in namespace.items():
            setattr(repair, name, value)
        gid = grp.getgrnam('matrix').gr_gid
        anchor = repair.open_environment('/', 0, gid)
        data, info = repair.read_file(anchor.fds[-1], 'host.env', 0, gid)
        _, values, _ = repair.parse(data)
        # The repair primitive deliberately watches a narrow env allowlist.
        # Authenticate from one bounded literal sync-token line without sourcing.
        sync_tokens = re.findall(rb'^MATRIX_SYNC_RUNTIME_TOKEN=([a-f0-9]{64})$', data, re.MULTILINE)
        require(len(sync_tokens) == 1 and len(re.findall(rb'^\s*(?:export\s+)?MATRIX_SYNC_RUNTIME_TOKEN\s*=', data, re.MULTILINE)) == 1)
        require(values.get('MATRIX_RUNTIME_SLOT') == 'primary'
                and re.fullmatch(r'[1-9][0-9]{0,9}', values.get('MATRIX_RUNTIME_TOKEN_EPOCH', ''))
                and len(sync_tokens) == 1)
        epoch = int(values['MATRIX_RUNTIME_TOKEN_EPOCH'])
        require(epoch <= 2147483647)
        identity = {'handle': values.get('MATRIX_HANDLE'), 'machineId': values.get('MATRIX_MACHINE_ID'),
                    'runtimeSlot': 'primary', 'runtimeTokenEpoch': epoch}
        require(isinstance(identity['handle'], str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{1,62}', identity['handle'])
                and isinstance(identity['machineId'], str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', identity['machineId']))
        local_identity = {'handle': identity['handle'], 'machineId': identity['machineId'],
                          'ownerId': values.get('MATRIX_CLERK_USER_ID'), 'runtimeSlot': 'primary', 'epoch': epoch}
        if action != 'admit':
            activity(repair, receipt['version'])
        expected = {'sha256': digest(data), 'inode': info.st_ino, 'device': info.st_dev}
        if action == 'inspect':
            return digest(data)
        if action in ('apply', 'admit', 'admit-stopped'):
            # Existing nonproduction managed routing is an intentional override.
            current_relay = values.get('MATRIX_FUNDED_AI_RELAY_URL', '')
            require(not current_relay or re.fullmatch(r'https://matrix-ai-relay-production-[a-z0-9]+(?:-[a-z0-9]+)?\.a\.run\.app', current_relay))
            current_platform = values.get('MATRIX_FUNDED_AI_PLATFORM_URL', '')
            require(current_platform in ('', 'https://app.matrix-os.com'))
            response = json_bytes(get('/internal/containers/' + identity['handle'] + '/funded-host-config', {
                'Authorization': 'Bearer ' + sync_tokens[0].decode(),
                'x-matrix-machine-id': identity['machineId'], 'x-matrix-runtime-slot': 'primary',
                'x-matrix-runtime-token-epoch': str(epoch)}))
            config = validate_response(response, identity, receipt['sourceSha'], time.time())
            require(current_relay in ('', config['MATRIX_FUNDED_AI_RELAY_URL']))
            if action in ('admit', 'admit-stopped'):
                return any(values.get(key) != value for key, value in config.items())
            rollout = 'repair-' + digest(receipt['version'].encode())[:24]
            request = {'action': 'apply', 'rolloutId': rollout, 'identity': local_identity, 'expectedFile': expected,
                       'quiescentWindow': True, 'config': {'relayUrl': config['MATRIX_FUNDED_AI_RELAY_URL'],
                       'runtimeToken': config['MATRIX_FUNDED_AI_RUNTIME_TOKEN'], 'platformUrl': config['MATRIX_FUNDED_AI_PLATFORM_URL']}}
            def guard():
                validate_response(response, identity, receipt['sourceSha'], time.time())
                activity(repair, receipt['version'])
            if any(values.get(key) != value for key, value in config.items()):
                state.write('applied.json', json.dumps({'rolloutId': rollout, 'identity': local_identity,
                            'beforeSha256': digest(data)}, separators=(',', ':')).encode(), 0o600)
            result = repair._execute(request, anchor, 0, gid, guard)
            if result['changed']:
                state.write('applied.json', json.dumps({'rolloutId': rollout, 'identity': local_identity,
                            'afterSha256': result['afterSha256']}, separators=(',', ':')).encode(), 0o600)
        else:
            applied = json_bytes(state.read('applied.json'))
            require(applied.get('identity') == local_identity)
            request = {'action': 'rollback', 'rolloutId': applied['rolloutId'], 'identity': local_identity,
                       'expectedFile': expected, 'quiescentWindow': True}
            try:
                result = repair._execute(request, anchor, 0, gid, lambda: activity(repair, receipt['version']))
            except (repair.RepairError, FileNotFoundError):
                require(digest(data) == applied.get('beforeSha256'))
                result = {'changed': False, 'restartRequired': False}
            os.unlink('applied.json', dir_fd=state.fds[-1])
            os.fsync(state.fds[-1])
        # Neither apply nor rollback starts/stops services. The fixed updater
        # resumes them after the oneshot finishes and performs health readback.
        print(json.dumps({'action': action, 'changed': result['changed'], 'restartRequired': result['restartRequired']}))
    finally:
        if anchor is not None:
            anchor.close()
        lib.close()
        state.close()


def validate_invocation(invocation, receipt, current, now):
    require(isinstance(invocation, dict) and set(invocation) == {'version', 'sourceSha', 'kind', 'createdAt', 'expiresAt', 'operation', 'priorVersion'}
            and invocation['kind'] == 'explicit-update' and invocation['version'] == receipt['version']
            and invocation['sourceSha'] == receipt['sourceSha'] and current.get('version') == receipt['version']
            and current.get('gitCommit') == receipt['sourceSha']
            and type(invocation['createdAt']) in (float, int) and type(invocation['expiresAt']) in (float, int)
            and invocation['createdAt'] <= now < invocation['expiresAt']
            and 0 < invocation['expiresAt'] - invocation['createdAt'] <= 30
            and invocation['operation'] in ('apply', 'rollback')
            and ((invocation['operation'] == 'apply' and invocation['priorVersion'] is None)
                 or (invocation['operation'] == 'rollback' and isinstance(invocation['priorVersion'], str)
                     and re.fullmatch(r'[A-Za-z0-9._-]{1,128}', invocation['priorVersion'])
                     and invocation['priorVersion'] != invocation['version'])))


def maintenance():
    """One consumed protected explicit-update admission; fixed services only."""
    state = Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
    previously_running, stopped, rollback = [], False, False
    try:
        invocation = json_bytes(state.read('invocation.json'))
        receipt = json_bytes(state.read('receipt.json'))
        fd = os.open('/opt/matrix/release.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
                    and info.st_nlink == 1 and info.st_size <= 65536)
            current = json_bytes(os.read(fd, 65537))
        finally:
            os.close(fd)
        validate_invocation(invocation, receipt, current, time.time())
        verify_installed_bundle(receipt['version'])
        state.verify()
        os.unlink('invocation.json', dir_fd=state.fds[-1])
        os.fsync(state.fds[-1])  # Consume before even read-only admission; no replay.
        rollback = invocation['operation'] == 'rollback'
        if rollback:
            previous = json_bytes(state.read('previous-receipt.json'))
            require(previous['version'] == invocation['priorVersion'])
        needs_change = run('admit')  # Default-off / expired / active-hold / override: no stop.
        if not rollback and not needs_change:
            return
        for service in SERVICES:
            _, load = systemctl('show', '--property=LoadState', '--value', service)
            if service in OPTIONAL_SERVICES and load == 'not-found':
                continue
            require(load == 'loaded')
            _, kill = systemctl('show', '--property=KillMode', '--value', service)
            require(kill in ('control-group', 'mixed'))
            _, active = systemctl('is-active', service)
            require(active in ('active', 'inactive', 'failed'))
            if active == 'active':
                previously_running.append(service)
        require('matrix-gateway.service' in previously_running and 'matrix-sync-agent.service' in previously_running)
        validate_invocation(invocation, receipt, current, time.time())
        verify_installed_bundle(receipt['version'])
        state.write('resume.json', json.dumps({'services': previously_running, 'version': receipt['version'],
                    'sourceSha': receipt['sourceSha']}, separators=(',', ':')).encode(), 0o600)
        stopped = True
        for service in previously_running:
            code, _ = systemctl('stop', service)
            require(code == 0)
        if rollback:
            run('admit-stopped')  # Fresh read-only financial admission again.
            run('rollback')
        else:
            before = run('inspect')
            try:
                run('apply')
            except Exception:
                try:
                    try:
                        intent = json_bytes(state.read('applied.json'))
                    except FileNotFoundError:
                        intent = {}
                    if run('inspect') != before or intent.get('beforeSha256') == before:
                        run('rollback')
                except Exception:
                    state.write('resume.json', json.dumps({'services': ['matrix-sync-agent.service'],
                                'version': receipt['version'], 'sourceSha': receipt['sourceSha']}).encode(), 0o600)
                raise
    finally:
        if stopped:
            resume()
        state.close()
    # Keep the current protected component bound to the still-installed app.
    # The explicit prior-version deployment installs its verified component
    # after guarded field rollback and independent readback; startup stays inert.


def resume():
    """Also ExecStopPost: restore fixed prior active services after unit timeout."""
    state = Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
    try:
        try:
            previous = json_bytes(state.read('resume.json'))
        except FileNotFoundError:
            return
        receipt = json_bytes(state.read('receipt.json'))
        require(set(previous) == {'services', 'version', 'sourceSha'} and previous['version'] == receipt['version']
                and previous['sourceSha'] == receipt['sourceSha'] and isinstance(previous['services'], list)
                and len(previous['services']) <= len(SERVICES) and len(set(previous['services'])) == len(previous['services']))
        require(set(previous['services']) <= set(SERVICES))
        # Sync resumes last so another pending update cannot race Gateway restore.
        for service in SERVICES:
            if service in previous['services']:
                code, _ = systemctl('start', service)
                require(code == 0)
        state.verify()
        os.unlink('resume.json', dir_fd=state.fds[-1])
        os.fsync(state.fds[-1])
    finally:
        state.close()

"""Real archive/descriptor and contract regressions; no customer operations."""
import hashlib
import importlib.util
import io
import json
import os
import sys
from pathlib import Path
import tarfile
import tempfile
import unittest
import sys
from unittest.mock import patch
from urllib.parse import urlencode
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[3]
sys.dont_write_bytecode = True


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load('installer', 'distro/customer-vps/funded-host-config/install.py')
runtime = load('runtime', 'distro/customer-vps/funded-host-config/reconcile.py')
runtime.__dict__.update({name: value for name, value in vars(installer).items() if not name.startswith('__')})
exec(compile((ROOT / 'distro/customer-vps/funded-host-config/recovery.py').read_text(), '<protected-recovery>', 'exec'), runtime.__dict__)
SHA = 'a' * 40
VERSION = 'v-test-repair'


def signed_url(version=VERSION):
    query = {'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'testkey/20261009/auto/s3/aws4_request',
             'X-Amz-Date': '20261009T000000Z', 'X-Amz-Expires': '300', 'X-Amz-SignedHeaders': 'host',
             'X-Amz-Signature': 'a' * 64, 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
             'x-amz-checksum-mode': 'ENABLED', 'x-id': 'GetObject'}
    return 'https://bundles.' + 'a' * 32 + '.eu.r2.cloudflarestorage.com/system-bundles/' + version + '/matrix-host-bundle.tar.gz?' + urlencode(query)


def archive(entries=None):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w:gz') as tar:
        for name, data, kind in entries or [(n, b'print("verified")\n', tarfile.REGTYPE) for n in installer.MEMBERS]:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(data) if kind == tarfile.REGTYPE else 0
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                info.linkname = '/tmp/malicious'
            tar.addfile(info, io.BytesIO(data))
    return result.getvalue()


class ComponentTests(unittest.TestCase):
    def snapshot(self, data, expected=None):
        source = tempfile.NamedTemporaryFile()
        source.write(data)
        source.seek(0)
        metadata = {'version': VERSION, 'gitCommit': SHA, 'size': len(data),
                    'sha256': expected or hashlib.sha256(data).hexdigest()}
        return source, metadata

    def test_verified_archive_extracts_only_exact_members(self):
        source, metadata = self.snapshot(archive())
        with source, tempfile.TemporaryFile() as protected:
            installer.snapshot(source.fileno(), protected.fileno(), metadata)
            self.assertEqual(set(installer.payload(protected.fileno())), set(installer.MEMBERS))

    def test_exact_protected_directory_header_is_optional_but_only_directory(self):
        normal = [(n, b'valid', tarfile.REGTYPE) for n in installer.MEMBERS]
        for dirname in ('funded-host-config/', './funded-host-config/'):
            source, metadata = self.snapshot(archive([(dirname, b'', tarfile.DIRTYPE)] + normal))
            with source, tempfile.TemporaryFile() as protected:
                installer.snapshot(source.fileno(), protected.fileno(), metadata)
                self.assertEqual(set(installer.payload(protected.fileno())), set(installer.MEMBERS))
        for entries in ([("funded-host-config", b'x', tarfile.REGTYPE)] + normal,
                        [("funded-host-config", b'', tarfile.SYMTYPE)] + normal,
                        [("funded-host-config", b'', tarfile.LNKTYPE)] + normal,
                        [('funded-host-config/', b'', tarfile.DIRTYPE), ('./funded-host-config/', b'', tarfile.DIRTYPE)] + normal,
                        [('funded-host-config/subdir/', b'', tarfile.DIRTYPE)] + normal,
                        [('funded-host-config/extra', b'x', tarfile.REGTYPE)] + normal):
            with self.subTest(entries=entries):
                source, metadata = self.snapshot(archive(entries))
                with source, tempfile.TemporaryFile() as protected:
                    installer.snapshot(source.fileno(), protected.fileno(), metadata)
                    with self.assertRaises(installer.ConfigError):
                        installer.payload(protected.fileno())

    def test_wrong_digest_and_size_fail_before_extraction(self):
        for modification in ('digest', 'size'):
            source, metadata = self.snapshot(archive())
            metadata['sha256' if modification == 'digest' else 'size'] = 'b' * 64 if modification == 'digest' else 1
            with source, tempfile.TemporaryFile() as protected, self.assertRaises(installer.ConfigError):
                installer.snapshot(source.fileno(), protected.fileno(), metadata)

    def test_rejects_duplicate_traversal_and_link_members(self):
        normal = [(n, b'valid', tarfile.REGTYPE) for n in installer.MEMBERS]
        cases = [normal + [normal[0]], normal + [('../evil', b'x', tarfile.REGTYPE)],
                 normal + [('funded-host-config/evil', b'', tarfile.SYMTYPE)],
                 [(normal[0][0], b'', tarfile.LNKTYPE)] + normal[1:]]
        for entries in cases:
            source, metadata = self.snapshot(archive(entries))
            with source, tempfile.TemporaryFile() as protected:
                installer.snapshot(source.fileno(), protected.fileno(), metadata)
                with self.assertRaises(installer.ConfigError):
                    installer.payload(protected.fileno())

    def test_protected_destination_rebind_confines_write_and_fails(self):
        with tempfile.TemporaryDirectory() as base:
            os.mkdir(base + '/lib', 0o755)
            anchor = installer.Directory(base, ('lib',), os.getuid())
            os.rename(base + '/lib', base + '/old')
            os.symlink(base + '/old', base + '/lib')
            with self.assertRaises(installer.ConfigError):
                anchor.write('component.py', b'inert', 0o644)
            self.assertFalse(os.path.exists(base + '/old/component.py'))
            anchor.close()

    def test_response_requires_exact_fresh_bound_schema(self):
        identity = {'handle': 'test-main', 'machineId': '12345678-1234-4234-9234-123456789012',
                    'runtimeSlot': 'primary', 'runtimeTokenEpoch': 2}
        response = {'contractVersion': 1, 'kind': 'matrix-funded-host-config', 'source': 'platform',
                    'sourceSha': SHA, 'issuedAt': '2026-10-09T00:00:00.000Z', 'expiresAt': '2026-10-09T00:00:30.000Z',
                    'identity': identity, 'configuration': {'MATRIX_FUNDED_AI_ENABLED': 'true',
                    'MATRIX_FUNDED_AI_RELAY_URL': 'https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app',
                    'MATRIX_FUNDED_AI_RUNTIME_TOKEN': 'c' * 64, 'MATRIX_FUNDED_AI_PLATFORM_URL': 'https://app.matrix-os.com'}}
        self.assertEqual(runtime.validate_response(response, identity, SHA, 1791504001), response['configuration'])
        for field, value in [('sourceSha', 'b' * 40), ('expiresAt', '2026-10-09T00:00:31.000Z'),
                             ('issuedAt', '2026-10-09T00:00:05.000Z'), ('command', 'id')]:
            changed = dict(response, **{field: value})
            with self.assertRaises(installer.ConfigError):
                runtime.validate_response(changed, identity, SHA, 1791504001)
        with self.assertRaises(installer.ConfigError):
            runtime.validate_response(response, identity, SHA, 1791504031)

    def test_metadata_cannot_supply_other_origin_or_source(self):
        good = {'version': VERSION, 'gitCommit': SHA, 'size': 100, 'sha256': 'a' * 64}
        self.assertEqual(installer.validate_metadata(good, VERSION, SHA), good)
        with self.assertRaises(installer.ConfigError):
            installer.validate_metadata(dict(good, gitCommit='b' * 40), VERSION, SHA)
        self.assertEqual(installer.validate_metadata(dict(good, url='https://account.r2.cloudflarestorage.com/bucket/system-bundles/' + VERSION + '/matrix-host-bundle.tar.gz?signature=opaque'), VERSION, SHA)['sha256'], good['sha256'])

    def test_stale_invocation_wrong_artifact_and_extra_fields_cannot_stop(self):
        receipt = {'version': VERSION, 'sourceSha': SHA}
        current = {'version': VERSION, 'gitCommit': SHA}
        invocation = {'version': VERSION, 'sourceSha': SHA, 'kind': 'explicit-update', 'createdAt': 100, 'expiresAt': 130,
                      'operation': 'apply', 'priorVersion': None}
        runtime.validate_invocation(invocation, receipt, current, 101)
        for changed in (dict(invocation, expiresAt=200), dict(invocation, kind='startup'),
                        dict(invocation, command='stop'), dict(invocation, version='old')):
            with self.assertRaises(installer.ConfigError):
                runtime.validate_invocation(changed, receipt, current, 101)
        for changed in (dict(current, version='old'), dict(current, gitCommit='b' * 40)):
            with self.assertRaises(installer.ConfigError):
                runtime.validate_invocation(invocation, receipt, changed, 101)
        with self.assertRaises(installer.ConfigError):
            runtime.validate_invocation(invocation, receipt, current, 131)

    def test_hardlinked_archive_and_oversized_member_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = root + '/archive'
            data = archive()
            Path(path).write_bytes(data)
            os.link(path, root + '/linked')
            with open(path, 'rb') as source, tempfile.TemporaryFile() as copy, self.assertRaises(installer.ConfigError):
                installer.snapshot(source.fileno(), copy.fileno(), {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        entries = [(n, b'x' * 1048577, tarfile.REGTYPE) for n in installer.MEMBERS]
        source, meta = self.snapshot(archive(entries))
        with source, tempfile.TemporaryFile() as copy:
            installer.snapshot(source.fileno(), copy.fileno(), meta)
            with self.assertRaises(installer.ConfigError):
                installer.payload(copy.fileno())

    def test_duplicate_json_credentials_rejected(self):
        with self.assertRaises(installer.ConfigError):
            installer.json_bytes(b'{"token":"a","token":"b"}')

    def test_presigned_artifact_freezes_exact_host_path_query(self):
        good = signed_url()
        host, path = installer.artifact_target(good, VERSION)
        self.assertTrue(host.endswith('.eu.r2.cloudflarestorage.com'))
        self.assertTrue(path.startswith('/system-bundles/' + VERSION + '/matrix-host-bundle.tar.gz?'))
        for bad in (good.replace('https:', 'http:'), good.replace('.r2.cloudflarestorage.com', '.evil.example'),
                    good.replace('/system-bundles/', '/other/'), good.replace(VERSION, 'old'),
                    good + '&X-Amz-Expires=300', good + '&command=id', good + '#fragment',
                    good.replace('https://', 'https://user@'), good.replace('/matrix-host-bundle.tar.gz', '/%6datrix-host-bundle.tar.gz')):
            with self.assertRaises(installer.ConfigError):
                installer.artifact_target(bad, VERSION)

    def test_private_or_documentation_dns_defers_and_numeric_tls_peer_is_pinned(self):
        for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '203.0.113.1', '::1'):
            with patch.object(installer.socket, 'getaddrinfo', return_value=[(0, 0, 0, '', (address, 443))]), self.assertRaises(installer.ConfigError):
                installer.public_addresses('observed.r2.cloudflarestorage.com')
        connection = object.__new__(installer.PinnedArtifactConnection)
        connection.host, connection.address = 'observed.r2.cloudflarestorage.com', '8.8.8.8'
        observed = []
        raw = type('Raw', (), {'close': lambda self: None})()
        wrapped = type('TLS', (), {'getpeername': lambda self: ('8.8.8.8', 443)})()
        connection._context = type('Context', (), {'wrap_socket': lambda self, sock, server_hostname: observed.append(server_hostname) or wrapped})()
        with patch.object(installer.socket, 'create_connection', return_value=raw) as connect, patch.object(installer.socket, 'getaddrinfo', side_effect=AssertionError('DNS repeated')):
            connection.connect()
            connect.assert_called_once_with(('8.8.8.8', 443), timeout=15)
        self.assertEqual(observed, ['observed.r2.cloudflarestorage.com'])

    def test_redirect_is_rejected_before_body_or_auth_forwarding(self):
        calls = []
        fake = type('HTTP', (), {'request': lambda self, method, path, headers: calls.append(headers),
            'getresponse': lambda self: type('Response', (), {'status': 302})(), 'close': lambda self: calls.append('closed')})()
        with self.assertRaises(installer.ConfigError):
            installer.get('/object?opaque', sink=lambda chunk: self.fail('body read'), transport=fake)
        self.assertEqual(calls, [{'User-Agent': 'matrix-funded-host-config/1'}, 'closed'])


    def test_archive_extension_headers_are_bounded_before_tar_parser_allocation(self):
        for kind in ('pax', 'gnu'):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w:gz', format=tarfile.PAX_FORMAT if kind == 'pax' else tarfile.GNU_FORMAT) as tar:
                info = tarfile.TarInfo('file' if kind == 'pax' else 'x' * 8192)
                if kind == 'pax':
                    info.pax_headers = {'comment': 'x' * 65537}
                tar.addfile(info, io.BytesIO(b''))
                for name in installer.MEMBERS:
                    normal = tarfile.TarInfo(name)
                    normal.size = 1
                    tar.addfile(normal, io.BytesIO(b'x'))
            source, meta = self.snapshot(data.getvalue())
            with source, tempfile.TemporaryFile() as copy:
                installer.snapshot(source.fileno(), copy.fileno(), meta)
                with self.assertRaises(installer.ConfigError):
                    installer.payload(copy.fileno())

    def test_actual_gzip_expansion_and_parse_deadline_are_bounded(self):
        source, meta = self.snapshot(archive())
        with source, tempfile.TemporaryFile() as copy:
            installer.snapshot(source.fileno(), copy.fileno(), meta)
            with patch.object(installer, 'MAX_EXPANSION', 128), self.assertRaises(installer.ConfigError):
                installer.payload(copy.fileno())
            with patch.object(installer.time, 'monotonic', side_effect=[0, 181]), self.assertRaises(installer.ConfigError):
                installer.payload(copy.fileno())


@unittest.skipUnless(os.geteuid() == 0 and os.path.isdir('/proc'), 'requires disposable root Linux')
class RootLifecycleTests(unittest.TestCase):
    """Actual protected filesystem + embedded repair, isolated network/services."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = self.temp.name
        self.patches = []
        for path, mode in [('opt', 0o755), ('opt/matrix', 0o770), ('opt/matrix/env', 0o750),
                           ('opt/matrix/staging', 0o755), ('opt/matrix/app', 0o755), ('usr', 0o755), ('usr/local', 0o755),
                           ('usr/local/libexec', 0o755), ('etc', 0o755), ('etc/systemd', 0o755),
                           ('etc/systemd/system', 0o755), ('var', 0o755), ('var/lib', 0o755)]:
            os.mkdir(self.root + '/' + path, mode)
        self.identity = {'handle': 'test-main', 'machineId': '12345678-1234-4234-9234-123456789012',
                         'runtimeSlot': 'primary', 'runtimeTokenEpoch': 2}
        self.original = ('# preserve owner config\nMATRIX_MACHINE_ID=' + self.identity['machineId'] +
                         '\nMATRIX_CLERK_USER_ID=user_test\nMATRIX_HANDLE=test-main\nMATRIX_RUNTIME_SLOT=primary\n'
                         'MATRIX_RUNTIME_TOKEN_EPOCH=2\nMATRIX_SYNC_RUNTIME_TOKEN=' + 'd' * 64 +
                         '\nPLATFORM_INTERNAL_URL=https://app.matrix-os.com\nUNRELATED="literal $value"\n').encode()
        self.env = self.root + '/opt/matrix/env/host.env'
        Path(self.env).write_bytes(self.original)
        os.chmod(self.env, 0o640)
        self.current = {'version': VERSION, 'gitCommit': SHA}
        Path(self.root + '/opt/matrix/release.json').write_text(json.dumps(self.current))
        Path(self.root + '/opt/matrix/app/BUNDLE_VERSION').write_text(self.current['version'] + '\n')
        code = (ROOT / 'distro/customer-vps/funded-host-config/reconcile.py').read_bytes()
        unit = (ROOT / 'distro/customer-vps/funded-host-config/matrix-funded-host-config.service').read_bytes()
        self.bytes = archive([(list(installer.MEMBERS)[0], code, tarfile.REGTYPE),
                              (list(installer.MEMBERS)[1], unit, tarfile.REGTYPE)])
        self.meta = dict(self.current, size=len(self.bytes), sha256=hashlib.sha256(self.bytes).hexdigest())
        Directory = installer.Directory
        self.Directory = Directory
        original_open, original_lexists, original_stat = os.open, os.path.lexists, os.stat
        def rooted_open(path, *args, **kwargs):
            if isinstance(path, str) and path.startswith('/opt/matrix/'):
                path = self.root + path
            return original_open(path, *args, **kwargs)
        def rooted_stat(path, *args, **kwargs):
            if isinstance(path, str) and path.startswith('/opt/matrix/'):
                path = self.root + path
            return original_stat(path, *args, **kwargs)
        def rooted_exists(path):
            if path.startswith(('/opt/matrix/', '/var/lib/matrix-funded-host-config/')):
                path = self.root + path
            return original_lexists(path)
        def directory(root, parts, uid=0, create=False):
            return Directory(self.root if root == '/' else root, parts, uid, create)
        for target, name, value in [(installer, 'Directory', directory), (runtime, 'Directory', directory),
                                    (os, 'open', rooted_open), (os, 'stat', rooted_stat), (os.path, 'lexists', rooted_exists)]:
            p = patch.object(target, name, value)
            p.start()
            self.patches.append(p)
        self.states = {name: 'active' for name in runtime.SERVICES}
        self.states['matrix-symphony.service'] = 'inactive'
        self.calls = []
        def ctl(*args):
            self.calls.append(args)
            service = args[-1]
            if args[0] == 'show':
                return 0, 'loaded' if 'LoadState' in args[1] else 'control-group'
            if args[0] == 'is-active':
                return 0, self.states[service]
            self.states[service] = 'inactive' if args[0] == 'stop' else 'active'
            return 0, ''
        p = patch.object(runtime, 'systemctl', ctl)
        p.start()
        self.patches.append(p)
        runtime.REPAIR_SOURCE = (ROOT / 'scripts/ops/repair-funded-chat-config.py').read_text().replace(
            'return Environment(base, uid, gid)', 'return Environment(' + repr(self.root) + ' if base == "/" else base, uid, gid)')
        p = patch.object(runtime.grp, 'getgrnam', lambda _: type('Group', (), {'gr_gid': 0})())
        p.start()
        self.patches.append(p)
        self.enabled = True
        self.responses = 0
        def remote(path, headers=None, sink=None, **kwargs):
            if path.endswith('.json') and path.startswith('/system-bundles/releases/'):
                return json.dumps(dict(self.meta, version=path.rsplit('/', 1)[-1].removesuffix('.json'))).encode()
            if sink is not None:
                sink(self.bytes)
                return len(self.bytes)
            if not self.enabled:
                raise installer.ConfigError('configuration_deferred')
            self.responses += 1
            self.assertEqual(headers['Authorization'], 'Bearer ' + 'd' * 64)
            now = runtime.time.time()
            stamp = lambda n: runtime.datetime.datetime.fromtimestamp(n, runtime.datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            return json.dumps({'contractVersion': 1, 'kind': 'matrix-funded-host-config', 'source': 'platform',
                'sourceSha': SHA, 'issuedAt': stamp(now - .1), 'expiresAt': stamp(now + 20), 'identity': self.identity,
                'configuration': {'MATRIX_FUNDED_AI_ENABLED': 'true', 'MATRIX_FUNDED_AI_RELAY_URL':
                'https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app', 'MATRIX_FUNDED_AI_RUNTIME_TOKEN': 'c' * 64,
                'MATRIX_FUNDED_AI_PLATFORM_URL': 'https://app.matrix-os.com'}}).encode()
        for target in (installer, runtime):
            p = patch.object(target, 'get', remote)
            p.start()
            self.patches.append(p)
        p = patch.object(installer, 'get_artifact', lambda meta, version, sink: remote('/artifact', sink=sink))
        p.start()
        self.patches.append(p)

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def admission(self):
        state = runtime.Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
        now = runtime.time.time()
        state.write('invocation.json', json.dumps({'version': self.current['version'], 'sourceSha': SHA,
                    'kind': 'explicit-update', 'createdAt': now, 'expiresAt': now + 30,
                    'operation': 'apply', 'priorVersion': None}).encode(), 0o600)
        state.close()

    def test_two_hops_install_apply_noop_guarded_rollback_preserve_owner_state(self):
        # First hop installs code but no config write or service operation.
        installer.install(VERSION, SHA)
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertEqual(self.calls, [])
        self.admission()
        runtime.maintenance()
        self.assertIn(b'MATRIX_FUNDED_AI_ENABLED=true\n', Path(self.env).read_bytes())
        self.assertEqual(self.responses, 2)
        self.assertEqual(self.states['matrix-symphony.service'], 'inactive')
        self.assertEqual(self.states['matrix-sync-agent.service'], 'active')
        self.assertEqual(len(list(Path(self.env).parent.glob('host.env.funded-*.json'))), 1)
        self.admission()
        runtime.maintenance()
        self.assertEqual(len(list(Path(self.env).parent.glob('host.env.funded-*.json'))), 1)
        for name in self.states:
            self.states[name] = 'inactive'
        runtime.run('rollback')
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        journals = {p.name: p.read_bytes() for p in Path(self.env).parent.glob('host.env.funded-*.json')}
        for name in self.states:
            self.states[name] = 'active' if name != 'matrix-symphony.service' else 'inactive'
        self.admission()
        runtime.maintenance()
        self.assertIn(b'MATRIX_FUNDED_AI_ENABLED=true\n', Path(self.env).read_bytes())
        self.assertEqual(len(list(Path(self.env).parent.glob('host.env.funded-*.json'))), 2)
        for name, data in journals.items():
            self.assertEqual((Path(self.env).parent / name).read_bytes(), data)
        marker = Path(self.root + '/var/lib/matrix-funded-host-config/applied.json')
        active = marker.read_bytes()
        changed = Path(self.env).read_bytes().replace(b'AI_ENABLED=true', b'AI_ENABLED=false')
        Path(self.env).write_bytes(changed)
        for name in self.states:
            self.states[name] = 'inactive'
        for retained in (active, b'{}'):
            marker.write_bytes(retained)
            with self.assertRaises(installer.ConfigError):
                runtime.run('apply')
            self.assertEqual(marker.read_bytes(), retained)
            self.assertEqual(Path(self.env).read_bytes(), changed)
            self.assertEqual(len(list(Path(self.env).parent.glob('host.env.funded-*.json'))), 2)

    def test_same_release_retry_after_late_guard_failure_preserves_failed_journal(self):
        installer.install(VERSION, SHA)
        original_activity, failed = runtime.activity, False
        def late_guard(repair, version):
            nonlocal failed
            original_activity(repair, version)
            if not failed and list(Path(self.env).parent.glob('host.env.funded-*.json')):
                failed = True
                raise installer.ConfigError('configuration_deferred')
        self.admission()
        with patch.object(runtime, 'activity', late_guard), self.assertRaises(installer.ConfigError):
            runtime.maintenance()
        self.assertTrue(failed)
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertFalse(Path(self.root + '/var/lib/matrix-funded-host-config/applied.json').exists())
        journals = {p.name: p.read_bytes() for p in Path(self.env).parent.glob('host.env.funded-*.json')}
        self.assertEqual(len(journals), 1)
        self.admission()
        runtime.maintenance()
        self.assertIn(b'MATRIX_FUNDED_AI_ENABLED=true\n', Path(self.env).read_bytes())
        self.assertEqual(len(list(Path(self.env).parent.glob('host.env.funded-*.json'))), 2)
        for name, data in journals.items():
            self.assertEqual((Path(self.env).parent / name).read_bytes(), data)

    def test_expired_unconsumed_invocation_is_retired_only_by_explicit_same_artifact(self):
        installer.install(VERSION, SHA)
        state = runtime.Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
        stale = {'version': VERSION, 'sourceSha': SHA, 'createdAt': 1, 'expiresAt': 30,
                 'kind': 'explicit-update', 'operation': 'apply', 'priorVersion': None}
        state.write('invocation.json', json.dumps(stale).encode(), 0o600)
        with patch('subprocess.run', return_value=type('Process', (), {'returncode': 0})()):
            installer.schedule(VERSION, SHA)
        fresh = json.loads(state.read('invocation.json'))
        self.assertGreater(fresh['expiresAt'], runtime.time.time())
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertEqual(self.calls, [])
        state.write('invocation.json', json.dumps(dict(stale, version='different')).encode(), 0o600)
        with self.assertRaises(installer.ConfigError):
            installer.schedule(VERSION, SHA)
        self.assertEqual(json.loads(state.read('invocation.json'))['version'], 'different')
        state.close()

    def test_mismatched_installed_bundle_cannot_stop_or_write(self):
        installer.install(VERSION, SHA)
        self.admission()
        Path(self.root + '/opt/matrix/app/BUNDLE_VERSION').write_text('other-version\n')
        with self.assertRaises(installer.ConfigError):
            runtime.maintenance()
        self.assertEqual(self.calls, [])
        self.assertEqual(Path(self.env).read_bytes(), self.original)

    def test_off_cohort_and_stale_invocation_never_stop_or_write(self):
        installer.install(VERSION, SHA)
        self.admission()
        self.enabled = False
        with self.assertRaises(installer.ConfigError):
            runtime.maintenance()
        self.assertEqual(self.calls, [])
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertFalse(Path(self.root + '/var/lib/matrix-funded-host-config/invocation.json').exists())
        self.enabled = True
        self.admission()
        runtime.maintenance()
        self.assertIn(b'MATRIX_FUNDED_AI_ENABLED=true\n', Path(self.env).read_bytes())

    def test_post_stop_deferral_restores_only_previously_running_services(self):
        installer.install(VERSION, SHA)
        self.admission()
        original = runtime.run
        def between(action, *args):
            if action == 'apply':
                self.enabled = False
            return original(action, *args)
        with patch.object(runtime, 'run', between), self.assertRaises(installer.ConfigError):
            runtime.maintenance()
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertEqual(self.states['matrix-gateway.service'], 'active')
        self.assertEqual(self.states['matrix-sync-agent.service'], 'active')
        self.assertEqual(self.states['matrix-symphony.service'], 'inactive')

    def test_marker_arriving_after_admission_is_not_this_invocations_rollback(self):
        installer.install(VERSION, SHA)
        self.admission()
        marker = Path(self.root + '/var/lib/matrix-funded-host-config/applied.json')
        identity = {'handle': self.identity['handle'], 'machineId': self.identity['machineId'],
                    'ownerId': 'user_test', 'runtimeSlot': 'primary', 'epoch': 2}
        intent = json.dumps({'rolloutId': 'repair-' + 'f' * 32, 'identity': identity,
                             'beforeSha256': hashlib.sha256(self.original).hexdigest()}).encode()
        original = runtime.run
        def arrival(action, *args):
            if action == 'apply':
                state = runtime.Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
                state.write('applied.json', intent, 0o600)
                state.close()
            return original(action, *args)
        with patch.object(runtime, 'run', arrival), self.assertRaises(installer.ConfigError):
            runtime.maintenance()
        self.assertEqual(marker.read_bytes(), intent)
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertEqual(list(Path(self.env).parent.glob('host.env.funded-*.json')), [])
        self.assertEqual(self.states['matrix-gateway.service'], 'active')
        for name in self.states:
            self.states[name] = 'inactive'
        with self.assertRaises(installer.ConfigError):
            runtime.run('rollback', {'rolloutId': 'repair-' + 'e' * 32})
        self.assertEqual(marker.read_bytes(), intent)

    def test_partial_apply_failure_reverts_before_runtime_resume(self):
        installer.install(VERSION, SHA)
        self.admission()
        write = self.Directory.write
        def fail_post_image(anchor, name, data, mode):
            if name == 'applied.json' and b'afterSha256' in data:
                raise installer.ConfigError('configuration_deferred')
            return write(anchor, name, data, mode)
        with patch.object(self.Directory, 'write', fail_post_image), self.assertRaises(installer.ConfigError):
            runtime.maintenance()
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertFalse(Path(self.root + '/var/lib/matrix-funded-host-config/applied.json').exists())
        self.assertEqual(self.states['matrix-gateway.service'], 'active')
        self.assertEqual(self.states['matrix-sync-agent.service'], 'active')

    def test_exact_prior_deploy_schedules_guarded_rollback_then_unblocks_prior_install(self):
        installer.install(VERSION, SHA)
        self.current = dict(self.current, version='v-test-repair-2')
        self.meta = dict(self.meta, version=self.current['version'])
        Path(self.root + '/opt/matrix/release.json').write_text(json.dumps(self.current))
        Path(self.root + '/opt/matrix/app/BUNDLE_VERSION').write_text(self.current['version'] + '\n')
        installer.install(self.current['version'], SHA)
        self.admission()
        runtime.maintenance()
        with patch('subprocess.run', return_value=type('Process', (), {'returncode': 0})()):
            installer.schedule(self.current['version'], SHA, 'rollback', VERSION)
            with self.assertRaises(installer.ConfigError):
                installer.schedule(self.current['version'], SHA, 'rollback', 'arbitrary-old')
        runtime.maintenance()
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertFalse(Path(self.root + '/var/lib/matrix-funded-host-config/applied.json').exists())
        self.assertEqual(json.loads(Path(self.root + '/var/lib/matrix-funded-host-config/receipt.json').read_text())['version'], self.current['version'])
        self.current = dict(self.current, version=VERSION)
        Path(self.root + '/opt/matrix/release.json').write_text(json.dumps(self.current))
        Path(self.root + '/opt/matrix/app/BUNDLE_VERSION').write_text(VERSION + '\n')
        self.meta = dict(self.meta, version=VERSION)
        installer.install(VERSION, SHA)
        self.assertEqual(Path(self.env).read_bytes(), self.original)


if __name__ == '__main__':
    unittest.main()

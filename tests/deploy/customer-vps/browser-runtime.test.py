import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path('distro/customer-vps/host-bin/matrix-browser-runtime.py')
spec = importlib.util.spec_from_file_location('browser_runtime', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BrowserRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.runtime = module.Runtime(self.root, os.getuid(), os.getgid())
        for path in ('opt/matrix/bin', 'opt/matrix/env', 'opt/matrix/app', 'etc/systemd/system'):
            (self.root / path).mkdir(parents=True, exist_ok=True)
        self.env = self.root / 'opt/matrix/env/host.env'
        self.env.write_text('MATRIX_MACHINE_ID=12345678-1234-1234-1234-123456789abc\nMATRIX_HANDLE=owner-handle\nMATRIX_RUNTIME_SLOT=primary\nMATRIX_CLERK_USER_ID=user_owner\nUNCHANGED=value\n')
        self.env.chmod(0o640)
        (self.root / 'opt/matrix/app/BUNDLE_VERSION').write_text('v-test')

    def test_hardens_fresh_group_writable_matrix_root_without_changing_children(self):
        parent = self.root / 'opt/matrix'
        parent.chmod(0o770)
        child = parent / 'owner-file'
        child.write_text('owner data')
        child.chmod(0o660)
        self.runtime.prepare()
        self.assertEqual(parent.stat().st_mode & 0o777, 0o755)
        self.assertEqual(child.stat().st_mode & 0o777, 0o660)
        self.assertEqual(child.read_text(), 'owner data')

    def test_refuses_symlink_parent_without_touching_target(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (self.root / 'opt/matrix/bin').rmdir()
        (self.root / 'opt/matrix/bin').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.runtime.prepare()
        self.assertEqual(list(outside.iterdir()), [])

    def test_refuses_world_writable_ancestor(self):
        (self.root / 'opt').chmod(0o777)
        with self.assertRaises(ValueError):
            self.runtime.prepare()

    def test_archive_rejects_links_and_traversal(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('linked', tarfile.SYMTYPE), ('/escape', tarfile.REGTYPE)):
            archive = self.root / 'archive.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = '/etc/passwd'
                member.size = 1 if kind == tarfile.REGTYPE else 0
                output.addfile(member, io.BytesIO(b'x'))
            destination = self.root / 'stage'
            destination.mkdir(exist_ok=True)
            with self.assertRaises(ValueError):
                self.runtime.extract(archive, destination)
            self.assertFalse((self.root / 'escape').exists())

    def test_environment_only_enables_after_health_preserving_keys_and_credential(self):
        self.runtime.prepare()
        self.runtime.write(self.env, self.env.read_text() + 'MATRIX_BROWSER_LAB_VIEWER_AUTH="Basic eDp5"\n', 0o640, self.runtime.gid)
        self.runtime.enable_environment()
        self.assertIn('UNCHANGED=value\n', self.env.read_text())
        self.assertEqual(self.env.read_text().count('MATRIX_BROWSER_LAB=true'), 1)
        self.assertIn('MATRIX_BROWSER_LAB_VIEWER_AUTH="Basic eDp5"', self.env.read_text())
        previous = self.env.read_bytes()
        self.runtime.enable_environment()
        self.assertEqual(self.env.read_bytes(), previous)

    def test_unsafe_host_environment_is_refused(self):
        self.env.chmod(0o666)
        with self.assertRaises(ValueError):
            self.runtime.enable_environment()

    def test_health_rejects_any_public_native_listener(self):
        for port in (5907, 6901, 8730, 9222):
            with patch.object(self.runtime, 'run', return_value=f'LISTEN 0 20 0.0.0.0:{port} 0.0.0.0:*\n'):
                with self.assertRaises(ValueError):
                    self.runtime.check_listeners()

    def test_health_requires_all_loopback_native_ports(self):
        with patch.object(self.runtime, 'run', return_value='\n'.join(f'LISTEN 0 20 127.0.0.1:{port} 0.0.0.0:*' for port in (6901, 8730, 9222))):
            self.runtime.check_listeners()
        with patch.object(self.runtime, 'run', return_value='LISTEN 0 20 127.0.0.1:9222 0.0.0.0:*'):
            with self.assertRaises(ValueError):
                self.runtime.check_listeners()

    def test_failed_native_health_restores_runtime_without_enabling_gateway(self):
        self.runtime.prepare()
        prefix = self.root / 'opt/matrix-browser-lab'
        (prefix / 'app').mkdir()
        (prefix / 'app/previous').write_text('keep')
        incoming = prefix / 'incoming'
        incoming.mkdir()
        (incoming / 'candidate').write_text('new')
        original = self.env.read_bytes()
        with patch.object(self.runtime, 'health', side_effect=ValueError('unhealthy')), patch.object(self.runtime, 'run', return_value=''), patch.object(module.time, 'sleep'):
            with self.assertRaises(ValueError):
                self.runtime.activate(incoming, {})
        self.assertEqual((prefix / 'app/previous').read_text(), 'keep')
        self.assertFalse((prefix / 'app/candidate').exists())
        self.assertEqual(self.env.read_bytes(), original)

    def test_warm_upgrade_does_not_restart_unchanged_chrome_or_display_units(self):
        self.runtime.prepare()
        prefix = self.runtime.prefix
        (prefix / 'app').mkdir()
        (prefix / 'app/previous').write_text('previous')
        incoming = prefix / 'incoming'
        incoming.mkdir()
        (incoming / 'candidate').write_text('candidate')
        files = {name: 'unchanged unit\n' for name in self.runtime.service_names}
        for name, content in files.items():
            self.runtime.write(self.runtime.units / name, content)
        self.runtime.write(self.env, self.env.read_text() + 'MATRIX_BROWSER_LAB_VIEWER_AUTH="Basic eDp5"\n', 0o640, self.runtime.gid)
        with patch.object(self.runtime, 'health'), patch.object(self.runtime, 'run', return_value='') as run:
            self.runtime.activate(incoming, files)
        restarts = [call.args[0] for call in run.call_args_list if 'restart' in call.args[0]]
        self.assertEqual(restarts, [
            ['/usr/bin/systemctl', 'restart', 'matrix-browser-lab.service'],
            ['/usr/bin/systemctl', 'restart', 'matrix-gateway.service'],
        ])
        self.assertEqual((prefix / 'app/candidate').read_text(), 'candidate')
        self.assertFalse((prefix / '.previous').exists())
        self.assertFalse((prefix / 'activation.json').exists())

    def test_interrupted_activation_restores_previous_app_and_environment_on_retry(self):
        self.runtime.prepare()
        prefix = self.root / 'opt/matrix-browser-lab'
        previous = prefix / '.previous'
        previous.mkdir()
        (previous / 'retained').write_text('previous')
        (prefix / 'app').mkdir()
        (prefix / 'app/candidate').write_text('candidate')
        original = self.env.read_bytes()
        self.runtime.write(prefix / 'activation.json', json.dumps({
            'hadApp': True, 'environment': module.base64.b64encode(original).decode(), 'files': {}}))
        self.runtime.write(self.env, original + b'MATRIX_BROWSER_LAB=true\n', 0o640, self.runtime.gid)
        with patch.object(self.runtime, 'run', return_value=''):
            self.runtime.recover_activation()
        self.assertEqual((prefix / 'app/retained').read_text(), 'previous')
        self.assertEqual(self.env.read_bytes(), original)
        self.assertFalse((prefix / 'activation.json').exists())

    def test_first_install_rollback_stops_units_before_removing_their_files(self):
        self.runtime.prepare()
        prefix = self.runtime.prefix
        (prefix / 'app').mkdir()
        unit = self.root / 'etc/systemd/system/matrix-browser-lab.service'
        unit.write_text('candidate')
        self.runtime.write(prefix / 'activation.json', json.dumps({'hadApp': False,
            'environment': module.base64.b64encode(self.env.read_bytes()).decode(),
            'files': {'matrix-browser-lab.service': None}}))
        calls = []
        def run(arguments, **kwargs):
            if 'disable' in arguments:
                self.assertTrue(unit.exists())
                self.assertTrue((prefix / 'app').exists())
            calls.append(arguments)
            return ''
        with patch.object(self.runtime, 'run', side_effect=run):
            self.runtime.recover_activation()
        self.assertTrue(any('disable' in command for command in calls))
        self.assertFalse(unit.exists())
        self.assertFalse((prefix / 'activation.json').exists())

    def test_nginx_adds_only_exact_viewer_upgrade_route_and_is_idempotent(self):
        source = 'server {\n  location /apps/ {\n    proxy_pass http://127.0.0.1:4000;\n  }\n}\n'
        result = module.viewer_location(source)
        self.assertIn('location = /apps/browser-lab/viewer/websockify', result)
        self.assertIn('proxy_set_header Upgrade $http_upgrade', result)
        self.assertEqual(module.viewer_location(result), result)
        with self.assertRaises(ValueError):
            module.viewer_location('server {}')

    def test_customer_admission_rejects_preview_missing_identity_and_owner_mismatch(self):
        original = self.env.read_text()
        for old, new in [('MATRIX_RUNTIME_SLOT=primary', 'MATRIX_RUNTIME_SLOT=pr-123'),
                         ('MATRIX_HANDLE=owner-handle', 'MATRIX_HANDLE=pv-123-12345678'),
                         ('12345678-1234-1234-1234-123456789abc', 'not-a-uuid')]:
            self.env.write_text(original.replace(old, new))
            with self.assertRaises(ValueError):
                self.runtime.environment()
        self.env.write_text(original + 'MATRIX_USER_ID=user_other\n')
        with self.assertRaises(ValueError):
            self.runtime.environment()

    def test_customer_local_alias_retains_existing_profile_during_reconciliation(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        local = self.root / 'home/matrix/.local'
        target = self.root / 'home/matrix/home/.local'
        profile = target / 'share/matrix-browser-lab/chrome'
        profile.mkdir(parents=True)
        marker = profile / 'retained-session'
        marker.write_text('owner session')
        local.symlink_to(target, target_is_directory=True)
        owner = type('Owner', (), {'pw_uid': os.getuid()})()
        files = {name: 'native unit' for name in self.runtime.service_names}
        files['tint2rc'] = 'panel'
        nginx = self.root / 'etc/nginx/sites-available/matrix'
        nginx.parent.mkdir(parents=True)
        self.runtime.write(nginx, 'server {\n location /apps/ {\n }\n}\n')
        def extract(archive, incoming):
            (incoming / 'runtime-services.json').write_text(json.dumps(files))
        with patch.object(self.runtime, 'preflight'), patch.object(self.runtime, 'verified_archive'), \
             patch.object(self.runtime, 'dependencies'), patch.object(self.runtime, 'credentials'), \
             patch.object(module.pwd, 'getpwnam', return_value=owner), \
             patch.object(self.runtime, 'run', return_value=''), \
             patch.object(self.runtime, 'extract', side_effect=extract), \
             patch.object(self.runtime, 'activate') as activate:
            self.runtime._reconcile()
        activate.assert_called_once()
        self.assertEqual(marker.read_text(), 'owner session')
        self.assertEqual(local.readlink(), target)
        self.assertEqual((self.runtime.prefix / 'installed-release').read_text(), 'v-test\n')

    def test_profile_rejects_noncanonical_alias_and_symlinked_chrome_directory(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        local = self.root / 'home/matrix/.local'
        local.parent.mkdir(parents=True)
        outside = self.root / 'outside'
        outside.mkdir()
        local.symlink_to(outside, target_is_directory=True)
        owner = type('Owner', (), {'pw_uid': os.getuid()})()
        with patch.object(self.runtime, 'preflight'), patch.object(self.runtime, 'verified_archive'), \
             patch.object(self.runtime, 'dependencies'), patch.object(self.runtime, 'credentials'), \
             patch.object(module.pwd, 'getpwnam', return_value=owner), \
             patch.object(self.runtime, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'Unsafe Browser owner profile'):
                self.runtime._reconcile()
            local.unlink()
            target = self.root / 'home/matrix/home/.local'
            profile = target / 'share/matrix-browser-lab/chrome'
            profile.parent.mkdir(parents=True)
            local.symlink_to(target, target_is_directory=True)
            profile.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'Unsafe Browser owner profile'):
                self.runtime._reconcile()
        run.assert_not_called()
        self.assertEqual(list(outside.iterdir()), [])

    def test_unsafe_profile_is_rejected_before_native_or_credential_mutation(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        local = self.root / 'home/matrix/.local'
        local.parent.mkdir(parents=True)
        local.symlink_to(self.root / 'outside', target_is_directory=True)
        with patch.object(self.runtime, 'preflight'), patch.object(self.runtime, 'verified_archive'), \
             patch.object(self.runtime, 'dependencies') as dependencies, patch.object(self.runtime, 'credentials') as credentials, \
             patch.object(module.pwd, 'getpwnam', return_value=type('Owner', (), {'pw_uid': os.getuid()})()):
            with self.assertRaises(ValueError):
                self.runtime._reconcile()
        dependencies.assert_not_called()
        credentials.assert_not_called()

    def test_explicit_disable_has_no_dependency_or_credential_side_effects(self):
        self.env.write_text(self.env.read_text() + 'MATRIX_BROWSER_LAB=false\n')
        with patch.object(self.runtime, 'dependencies') as dependencies, patch.object(self.runtime, 'credentials') as credentials:
            self.runtime.reconcile()
        dependencies.assert_not_called()
        credentials.assert_not_called()

    def test_resource_preflight_rejects_insufficient_ram_and_disk(self):
        (self.root / 'etc/os-release').write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
        (self.root / 'proc').mkdir()
        (self.root / 'proc/meminfo').write_text('MemTotal: 1048576 kB\n')
        with patch.object(module.os, 'uname', return_value=type('System', (), {'machine': 'x86_64'})()), self.assertRaises(ValueError):
            self.runtime.preflight()
        (self.root / 'proc/meminfo').write_text('MemTotal: 4194304 kB\n')
        with patch.object(module.os, 'uname', return_value=type('System', (), {'machine': 'x86_64'})()), patch.object(module.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 1024})()):
            with self.assertRaises(ValueError):
                self.runtime.preflight()

    def test_archive_checksum_must_match_protected_digest(self):
        self.runtime.prepare()
        archive = self.root / 'opt/matrix/bin/matrix-browser-runtime.tar.gz'
        archive.write_bytes(b'payload')
        archive.chmod(0o644)
        digest = archive.with_name(archive.name + '.sha256')
        digest.write_text('0' * 64 + '\n')
        with self.assertRaises(ValueError):
            self.runtime.verified_archive()
        digest.write_text(module.hashlib.sha256(b'payload').hexdigest() + '\n')
        self.assertEqual(self.runtime.verified_archive(), archive)
        digest.chmod(0o666)
        with self.assertRaises(ValueError):
            self.runtime.verified_archive()

    def test_failed_setup_exhausts_budget_instead_of_retrying_forever(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        with patch.object(self.runtime, '_reconcile', side_effect=ValueError('unhealthy')) as reconcile:
            for _ in range(3):
                with self.assertRaises(ValueError):
                    self.runtime.reconcile()
            # systemd's three-start limit prevents a fourth automatic call.
            state = json.loads((self.runtime.prefix / 'status.json').read_text())
            self.assertEqual(state['status'], 'exhausted')
            self.runtime.reconcile()
        self.assertEqual(reconcile.call_count, 3)
        state = json.loads((self.runtime.prefix / 'status.json').read_text())
        self.assertEqual(state['status'], 'exhausted')

    def test_interrupted_credential_publish_recovers_the_same_pair(self):
        self.runtime.prepare()
        def run(arguments, **kwargs):
            Path(arguments[-1]).write_text('hashed-passwd')
            return ''
        original_write = self.runtime.write
        def fail_environment(path, *args):
            if path == self.env:
                raise OSError('interrupted')
            return original_write(path, *args)
        with patch.object(self.runtime, 'run', side_effect=run), patch.object(module.os, 'chown'), patch.object(self.runtime, 'write', side_effect=fail_environment):
            with self.assertRaises(OSError):
                self.runtime.credentials()
        pending = json.loads((self.runtime.prefix / 'credential-pending.json').read_text())
        self.runtime.credentials()
        self.assertIn(pending['authorization'], self.env.read_text())
        self.assertEqual((self.runtime.prefix / 'viewer.passwd').read_text(), 'hashed-passwd')
        self.assertFalse((self.runtime.prefix / 'credential-pending.json').exists())

    def test_new_release_is_reconciled_even_if_previous_release_was_ready(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"previous","attempts":1,"status":"ready"}')
        with patch.object(self.runtime, '_reconcile') as reconcile, patch.object(self.runtime, 'health'):
            self.runtime.reconcile()
        reconcile.assert_called_once()

    def test_ready_runtime_with_agent_input_gate_is_not_restarted(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","attempts":1,"status":"ready"}')
        with patch.object(self.runtime, '_reconcile') as reconcile, patch.object(self.runtime, 'health') as health:
            self.runtime.reconcile()
        health.assert_called_once_with(allow_control_locked=True)
        reconcile.assert_not_called()

    def test_viewer_socket_requires_authenticated_101_and_matching_accept(self):
        class Connection:
            def __enter__(connection):
                return connection
            def __exit__(connection, *arguments):
                pass
            def sendall(connection, request):
                self.assertIn(b'Authorization: Basic eDp5', request)
                key = request.decode().split('Sec-WebSocket-Key: ')[1].split('\r\n')[0]
                accept = module.base64.b64encode(module.hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                connection.response = (f'HTTP/1.1 {connection.status}\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: binary\r\nSec-WebSocket-Accept: {accept}\r\n\r\n').encode()
            def recv(connection, limit):
                return connection.response
        for status in ('101 Switching Protocols', '200 OK', '401 Unauthorized'):
            connection = Connection()
            connection.status = status
            with patch.object(module.socket, 'create_connection', return_value=connection):
                if status.startswith('101'):
                    self.runtime.viewer_socket('Basic eDp5')
                else:
                    with self.assertRaises(ValueError):
                        self.runtime.viewer_socket('Basic eDp5')

    def test_status_and_retry_are_coarse_bounded_and_preserve_owner_credentials(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","attempts":3,"status":"exhausted","secret":"never expose"}')
        original = self.env.read_bytes()
        self.assertEqual(self.runtime.product_status(), {'status': 'exhausted', 'retryAvailable': True})
        with patch.object(self.runtime, 'run', return_value='activating\n') as run:
            self.assertEqual(self.runtime.retry(), {'status': 'installing', 'retryAvailable': False})
            self.runtime.retry()
        self.assertEqual(run.call_count, 3)
        self.assertEqual(self.env.read_bytes(), original)
        self.assertEqual(json.loads((self.runtime.prefix / 'status.json').read_text())['attempts'], 0)
        with patch.object(self.runtime, 'run', return_value='activating\n'):
            self.assertEqual(self.runtime.product_status(), {'status': 'installing', 'retryAvailable': False})

    def test_retry_respects_optout_and_never_restarts_ready_browser(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","status":"ready"}')
        with patch.object(self.runtime, 'run') as run:
            self.assertEqual(self.runtime.retry(), {'status': 'ready', 'retryAvailable': False})
            self.env.write_text(self.env.read_text() + 'MATRIX_BROWSER_LAB=false\n')
            self.assertEqual(self.runtime.retry(), {'status': 'disabled', 'retryAvailable': False})
        run.assert_not_called()

    def test_retry_budget_survives_failure_restart_and_expires_after_one_hour(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","attempts":3,"status":"exhausted"}')
        with patch.object(module.time, 'time', return_value=10000), patch.object(self.runtime, 'run', side_effect=OSError('service unavailable')):
            with self.assertRaises(OSError):
                self.runtime.retry()
        with patch.object(module.time, 'time', return_value=10001):
            self.assertEqual(self.runtime.product_status()['retryAvailable'], False)
        with patch.object(module.time, 'time', return_value=14000):
            self.assertEqual(self.runtime.product_status()['retryAvailable'], True)

    def test_interrupted_last_attempt_becomes_retryable_instead_of_stuck_installing(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","attempts":3,"status":"installing"}')
        with patch.object(self.runtime, 'run', return_value='failed\n'):
            self.assertEqual(self.runtime.product_status(), {'status': 'exhausted', 'retryAvailable': True})
        with patch.object(self.runtime, 'run', return_value='activating\n'):
            self.assertEqual(self.runtime.product_status(), {'status': 'installing', 'retryAvailable': False})

    def test_unsupported_platform_failure_is_recorded_and_bounded(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        release = self.root / 'etc/os-release'
        release.write_text('ID=debian\nVERSION_ID="12"\n')
        with patch.object(self.runtime, 'verified_archive'), patch.object(self.runtime, 'dependencies') as dependencies:
            for _ in range(3):
                with self.assertRaises(ValueError):
                    self.runtime.reconcile()
        dependencies.assert_not_called()
        self.assertEqual(self.runtime.product_status(), {'status': 'exhausted', 'retryAvailable': True})

    def test_first_owner_credentials_are_unique_for_each_sanitized_clone(self):
        self.runtime.prepare()
        def run(arguments, **kwargs):
            Path(arguments[-1]).write_text('hashed-' + kwargs['input'].splitlines()[0])
            return ''
        with patch.object(self.runtime, 'run', side_effect=run):
            self.runtime.credentials()
            first = self.runtime.environment()[1]['MATRIX_BROWSER_LAB_VIEWER_AUTH']
            self.runtime.credentials()
            self.assertEqual(self.runtime.environment()[1]['MATRIX_BROWSER_LAB_VIEWER_AUTH'], first)
            (self.runtime.prefix / 'viewer.passwd').unlink()
            self.env.write_text('\n'.join(line for line in self.env.read_text().splitlines() if not line.startswith('MATRIX_BROWSER_LAB_VIEWER_AUTH=')) + '\n')
            self.runtime.credentials()
        self.assertNotEqual(self.runtime.environment()[1]['MATRIX_BROWSER_LAB_VIEWER_AUTH'], first)

    def test_runtime_units_keep_native_ports_loopback_and_chrome_sandbox(self):
        units = json.loads(Path('scripts/spikes/browser-vps/runtime-services.json').read_text())
        self.assertIn('-interface 127.0.0.1', units['matrix-browser-lab-vnc.service'])
        chrome = units['matrix-browser-lab-chrome.service']
        self.assertIn('--remote-debugging-address=127.0.0.1', chrome)
        self.assertNotIn('--no-sandbox', chrome)
        self.assertIn('--user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome', chrome)
        for name, content in units.items():
            if name.endswith('.service'):
                self.assertIn('User=matrix', content)


if __name__ == '__main__':
    unittest.main()

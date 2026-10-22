import importlib.util
from contextlib import contextmanager
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

fixture_spec = importlib.util.spec_from_file_location('browser_health_fixture', Path('tests/deploy/customer-vps/browser-health-fixture.py'))
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)


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

    @contextmanager
    def durability_events(self):
        events = []
        fsync, rename, replace, unlink, rmtree = os.fsync, Path.rename, os.replace, Path.unlink, module.shutil.rmtree
        def observe_sync(descriptor):
            observed = os.fstat(descriptor)
            target = None
            for candidate in [self.root, *self.root.rglob('*')]:
                try:
                    info = candidate.lstat()
                except FileNotFoundError:
                    continue
                if (info.st_dev, info.st_ino) == (observed.st_dev, observed.st_ino):
                    target = candidate
                    break
            events.append(('fsync', target, module.stat.S_ISDIR(observed.st_mode)))
            return fsync(descriptor)
        def observe_rename(source, destination):
            events.append(('rename', source, destination))
            return rename(source, destination)
        def observe_replace(source, destination):
            events.append(('replace', source, destination))
            return replace(source, destination)
        def observe_unlink(path, *args, **kwargs):
            events.append(('unlink', path, None))
            return unlink(path, *args, **kwargs)
        def observe_rmtree(path, *args, **kwargs):
            events.append(('rmtree', path, None))
            return rmtree(path, *args, **kwargs)
        with patch.object(module.os, 'fsync', side_effect=observe_sync), \
             patch.object(Path, 'rename', observe_rename), patch.object(Path, 'unlink', observe_unlink), \
             patch.object(module.os, 'replace', side_effect=observe_replace), \
             patch.object(module.shutil, 'rmtree', side_effect=observe_rmtree):
            yield events

    def test_atomic_write_persists_real_parent_after_file_replacement(self):
        self.runtime.prepare()
        target = self.runtime.prefix / 'status.json'
        with self.durability_events() as events:
            self.runtime.write(target, 'durable state')
        publication = next(index for index, event in enumerate(events) if event[0] == 'replace' and event[2] == target)
        self.assertTrue(any(event[0] == 'fsync' and event[2] is False for event in events[:publication]))
        self.assertIn(('fsync', target.parent, True), events[publication + 1:])

    def test_activation_durability_orders_payload_journal_swaps_and_journal_retirement(self):
        self.runtime.prepare()
        self.runtime.write(self.env, self.env.read_text() + 'MATRIX_BROWSER_LAB_VIEWER_AUTH="Basic eDp5"\n', 0o640, self.runtime.gid)
        app, previous, journal = self.runtime.prefix / 'app', self.runtime.prefix / '.previous', self.runtime.prefix / 'activation.json'
        app.mkdir()
        (app / 'old').write_text('old durable payload')
        incoming = self.runtime.prefix / 'staged/app'
        incoming.mkdir(parents=True)
        (incoming / 'new').write_text('new payload bytes')
        with self.durability_events() as events, patch.object(self.runtime, 'health'), patch.object(self.runtime, 'run', return_value=''):
            self.runtime.activate(incoming, {})
        published = next(index for index, event in enumerate(events) if event[0] == 'replace' and event[2] == journal)
        swaps = [index for index, event in enumerate(events) if event[0] == 'rename']
        retired = next(index for index, event in enumerate(events) if event[:2] == ('unlink', journal))
        self.assertIn(('fsync', incoming / 'new', False), events[:published])
        self.assertIn(('fsync', self.runtime.prefix, True), events[published + 1:swaps[0]])
        self.assertIn(('fsync', self.runtime.prefix, True), events[swaps[0] + 1:swaps[1]])
        for parent in (incoming.parent, self.runtime.prefix):
            self.assertIn(('fsync', parent, True), events[swaps[1] + 1:retired])
        cleanup = next(index for index, event in enumerate(events) if event[:2] == ('rmtree', previous))
        self.assertIn(('fsync', journal.parent, True), events[retired + 1:cleanup])

    def test_failed_journal_directory_sync_prevents_app_swap_and_service_actions(self):
        self.runtime.prepare()
        self.runtime.write(self.env, self.env.read_text() + 'MATRIX_BROWSER_LAB_VIEWER_AUTH="Basic eDp5"\n', 0o640, self.runtime.gid)
        app = self.runtime.prefix / 'app'
        app.mkdir()
        (app / 'old').write_text('retained payload')
        incoming = self.runtime.prefix / 'incoming'
        incoming.mkdir()
        (incoming / 'new').write_text('candidate')
        fsync = os.fsync
        def fail_journal_publication(descriptor):
            info, expected = os.fstat(descriptor), self.runtime.prefix.stat()
            if (info.st_dev, info.st_ino) == (expected.st_dev, expected.st_ino) and (self.runtime.prefix / 'activation.json').exists():
                raise OSError('Injected journal directory sync failure')
            return fsync(descriptor)
        with patch.object(module.os, 'fsync', side_effect=fail_journal_publication), patch.object(self.runtime, 'health'), \
             patch.object(self.runtime, 'run', return_value='') as run, self.assertRaises(OSError):
            self.runtime.activate(incoming, {})
        run.assert_not_called()
        self.assertEqual((app / 'old').read_text(), 'retained payload')
        self.assertTrue(incoming.exists())
        self.assertFalse((self.runtime.prefix / '.previous').exists())

    def test_failed_app_rename_directory_sync_recovers_before_candidate_start(self):
        self.runtime.prepare()
        app, previous = self.runtime.prefix / 'app', self.runtime.prefix / '.previous'
        app.mkdir()
        (app / 'old').write_text('retained payload')
        incoming = self.runtime.prefix / 'incoming'
        incoming.mkdir()
        (incoming / 'new').write_text('candidate')
        fsync, failed = os.fsync, []
        def fail_after_previous_rename(descriptor):
            info, expected = os.fstat(descriptor), self.runtime.prefix.stat()
            if not failed and (info.st_dev, info.st_ino) == (expected.st_dev, expected.st_ino) and previous.exists() and not app.exists():
                failed.append(True)
                raise OSError('Injected namespace sync failure')
            return fsync(descriptor)
        with patch.object(module.os, 'fsync', side_effect=fail_after_previous_rename), \
             patch.object(self.runtime, 'run', return_value='') as run, self.assertRaises(OSError):
            self.runtime.activate(incoming, {})
        self.assertEqual(failed, [True])
        self.assertEqual((app / 'old').read_text(), 'retained payload')
        self.assertTrue(incoming.exists())
        self.assertFalse((self.runtime.prefix / 'activation.json').exists())
        self.assertFalse(any('enable' in call.args[0] for call in run.call_args_list))

    def test_recovery_and_credential_journal_retirement_sync_real_parent_directories(self):
        self.runtime.prepare()
        app, previous, journal = self.runtime.prefix / 'app', self.runtime.prefix / '.previous', self.runtime.prefix / 'activation.json'
        previous.mkdir()
        (previous / 'old').write_text('old')
        app.mkdir()
        self.runtime.write(journal, json.dumps({'hadApp': True, 'environment': module.base64.b64encode(self.env.read_bytes()).decode(), 'files': {}}), 0o600)
        with self.durability_events() as events, patch.object(self.runtime, 'run', return_value=''):
            self.runtime.recover_activation()
        renamed = next(index for index, event in enumerate(events) if event[0] == 'rename')
        retired = next(index for index, event in enumerate(events) if event[:2] == ('unlink', journal))
        self.assertIn(('fsync', self.runtime.prefix, True), events[renamed + 1:retired])
        self.assertIn(('fsync', journal.parent, True), events[retired + 1:])
        def kasm(arguments, **kwargs):
            Path(arguments[-1]).write_text('hashed credential')
            return ''
        with self.durability_events() as events, patch.object(self.runtime, 'run', side_effect=kasm), patch.object(module.os, 'chown'):
            self.runtime.credentials()
        pending = self.runtime.prefix / 'credential-pending.json'
        retired = next(index for index, event in enumerate(events) if event[:2] == ('unlink', pending))
        self.assertIn(('fsync', self.env.parent, True), events[:retired])
        self.assertIn(('fsync', pending.parent, True), events[retired + 1:])

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

    def test_native_enablement_never_owns_shell_origin(self):
        self.runtime.prepare()
        original = self.env.read_text()
        for shell_origin in (None, 'https://operator-shell.example', 'https://app.matrix-os.com'):
            with self.subTest(shell_origin=shell_origin):
                configured = original + 'MATRIX_PUBLIC_APP_URL=https://custom-app.example\nMATRIX_BROWSER_LAB_VIEWER_AUTH="Basic eDp5"\n'
                if shell_origin:
                    configured += f'SHELL_ORIGIN={shell_origin}\n'
                self.runtime.write(self.env, configured, 0o640, self.runtime.gid)
                self.runtime.enable_environment()
                current = self.env.read_text()
                self.assertIn('MATRIX_BROWSER_LAB=true', current)
                self.assertIn('MATRIX_PUBLIC_APP_URL=https://custom-app.example', current)
                origins = [line for line in current.splitlines() if line.startswith('SHELL_ORIGIN=')]
                self.assertEqual(origins, [f'SHELL_ORIGIN={shell_origin}'] if shell_origin else [])

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

    def test_native_health_accepts_real_supervisor_startup_without_opening_human_input(self):
        self.runtime.prepare()
        self.runtime.write(self.env, self.env.read_text() + 'MATRIX_BROWSER_LAB_VIEWER_AUTH="Basic eDp5"\n', 0o640, self.runtime.gid)
        with fixture.native_health_fixture() as (initial, opener, run, viewer_connection):
            self.assertFalse(initial['initial']['humanControlAvailable'])
            with patch.object(module.urllib.request, 'build_opener', return_value=opener), \
                 patch.object(self.runtime, 'run', side_effect=run), \
                 patch.object(module.socket, 'create_connection', side_effect=viewer_connection):
                self.runtime.health()
            with opener.open('http://127.0.0.1:8730/browser-status', timeout=2) as response:
                self.assertIs(json.loads(response.read())['humanControlAvailable'], False)

    def test_exhausted_interrupted_activation_recovers_before_budget_and_optout(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        original = self.env.read_bytes()
        profile = self.root / 'home/matrix/home/.local/share/matrix-browser-lab/chrome/session'
        profile.parent.mkdir(parents=True)
        profile.write_text('retained owner session')
        for disabled in (False, True):
            with self.subTest(disabled=disabled):
                app, previous = self.runtime.prefix / 'app', self.runtime.prefix / '.previous'
                for tree in (app, previous):
                    if tree.exists():
                        module.shutil.rmtree(tree)
                previous.mkdir()
                (previous / 'retained').write_text('previous native runtime')
                app.mkdir(exist_ok=True)
                (app / 'candidate').write_text('interrupted candidate')
                self.runtime.write(self.runtime.prefix / 'activation.json', json.dumps({'hadApp': True,
                    'environment': module.base64.b64encode(original).decode(), 'files': {}}), 0o600)
                self.runtime.write(self.env, original + b'CURRENT_NON_BROWSER_KEY=preserved\nMATRIX_FUNDED_AI_RUNTIME_TOKEN=new-token\n' + ('MATRIX_BROWSER_LAB=false\n' if disabled else 'MATRIX_BROWSER_LAB=true\n').encode(), 0o640, self.runtime.gid)
                self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","attempts":3,"status":"installing"}')
                with patch.object(self.runtime, 'run', return_value=''), patch.object(self.runtime, '_reconcile') as attempt:
                    self.runtime.reconcile()
                attempt.assert_not_called()
                self.assertEqual((app / 'retained').read_text(), 'previous native runtime')
                self.assertFalse((app / 'candidate').exists())
                self.assertFalse((self.runtime.prefix / 'activation.json').exists())
                self.assertEqual(json.loads((self.runtime.prefix / 'status.json').read_text())['status'], 'disabled' if disabled else 'exhausted')
                if disabled:
                    self.assertEqual(self.runtime.environment()[1]['MATRIX_BROWSER_LAB'], 'false')
                self.assertIn('CURRENT_NON_BROWSER_KEY=preserved', self.env.read_text())
                self.assertIn('MATRIX_FUNDED_AI_RUNTIME_TOKEN=new-token', self.env.read_text())
                self.assertEqual(profile.read_text(), 'retained owner session')

    def test_activation_recovery_preserves_operator_origin_changes(self):
        self.runtime.prepare()
        original = self.env.read_text()
        for saved_origin, current_origin, expected in (
                (None, 'https://app.matrix-os.com', 'https://app.matrix-os.com'),
                (None, 'https://new-operator.example', 'https://new-operator.example'),
                ('https://old-operator.example', 'https://new-operator.example', 'https://new-operator.example'),
                ('https://old-operator.example', None, None)):
            with self.subTest(saved=saved_origin, current=current_origin):
                saved = original + (f'SHELL_ORIGIN={saved_origin}\n' if saved_origin else '')
                current = original + (f'SHELL_ORIGIN={current_origin}\n' if current_origin else '')
                self.runtime.write(self.env, current, 0o640, self.runtime.gid)
                self.runtime.write(self.runtime.prefix / 'activation.json', json.dumps({'hadApp': False,
                    'environment': module.base64.b64encode(saved.encode()).decode(), 'files': {}}), 0o600)
                with patch.object(self.runtime, 'run', return_value=''):
                    self.runtime.recover_activation()
                origins = [line for line in self.env.read_text().splitlines() if line.startswith('SHELL_ORIGIN=')]
                self.assertEqual(origins, [f'SHELL_ORIGIN={expected}'] if expected else [])

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
        health.assert_called_once_with()
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
        with patch.object(self.runtime, 'run', return_value='active\n' * 6) as run:
            self.assertEqual(self.runtime.retry(), {'status': 'ready', 'retryAvailable': False})
            self.env.write_text(self.env.read_text() + 'MATRIX_BROWSER_LAB=false\n')
            self.assertEqual(self.runtime.retry(), {'status': 'disabled', 'retryAvailable': False})
        run.assert_called_once_with(['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', *self.runtime.service_names], timeout=2)

    def test_ready_status_checks_all_native_services_once_without_full_health(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","status":"ready"}')
        with patch.object(self.runtime, 'health') as health, patch.object(self.runtime, 'run', return_value='active\n\n' * 6) as run:
            self.assertEqual(self.runtime.product_status(), {'status': 'ready', 'retryAvailable': False})
        run.assert_called_once_with(['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', *self.runtime.service_names], timeout=2)
        health.assert_not_called()
        for index in range(6):
            for active in ('inactive', 'failed', 'activating', 'deactivating', 'reloading'):
                with self.subTest(unit=index, state=active):
                    states = ['active'] * 6
                    states[index] = active
                    with patch.object(self.runtime, 'run', return_value='\n'.join(states)):
                        failed = active in ('inactive', 'failed')
                        self.assertEqual(self.runtime.product_status(), {'status': 'failed' if failed else 'installing', 'retryAvailable': failed})
        self.assertEqual(json.loads((self.runtime.prefix / 'status.json').read_text())['status'], 'ready')

    def test_ready_status_rejects_missing_extra_and_unknown_service_states(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","status":"ready"}')
        for states in ('active\n' * 5, 'active\n' * 7, 'active\n' * 5 + 'unknown\n'):
            with patch.object(self.runtime, 'run', return_value=states), self.assertRaises(ValueError):
                self.runtime.product_status()

    def test_stopped_ready_browser_can_retry_but_retains_manual_cooldown(self):
        self.runtime.prepare()
        for name in self.runtime.service_names:
            self.runtime.write(self.runtime.units / name, 'native unit')
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","status":"ready"}')
        before = self.env.read_bytes()
        with patch.object(self.runtime, 'run', return_value='active\n' * 5 + 'failed\n') as run:
            self.assertEqual(self.runtime.retry(), {'status': 'installing', 'retryAvailable': False})
        self.assertEqual([call.args[0] for call in run.call_args_list][1:], [
            ['/usr/bin/systemctl', 'reset-failed', 'matrix-browser-runtime.service', *self.runtime.service_names],
            ['/usr/bin/systemctl', 'start', '--no-block', 'matrix-browser-runtime.service']])
        self.assertEqual(self.env.read_bytes(), before)
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","status":"ready"}')
        with patch.object(self.runtime, 'run', return_value='active\n' * 5 + 'inactive\n') as run:
            self.assertEqual(self.runtime.retry(), {'status': 'failed', 'retryAvailable': False})
        self.assertEqual(run.call_count, 1)

    def test_initial_retry_omits_unknown_native_units_before_they_are_installed(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.units / 'matrix-browser-runtime.service', 'lifecycle unit')
        def systemctl(arguments, **kwargs):
            if arguments[1] == 'reset-failed':
                for name in arguments[2:]:
                    if not (self.runtime.units / name).is_file():
                        raise module.subprocess.CalledProcessError(1, arguments, stderr='Unit not loaded')
            return ''
        for status in ('pending', 'failed'):
            with self.subTest(status=status):
                (self.runtime.prefix / 'retry.json').unlink(missing_ok=True)
                self.runtime.write(self.runtime.prefix / 'status.json', json.dumps({'version': 'v-test', 'status': status}))
                with patch.object(self.runtime, 'run', side_effect=systemctl) as run:
                    self.assertEqual(self.runtime.retry(), {'status': 'installing', 'retryAvailable': False})
                self.assertEqual([call.args[0] for call in run.call_args_list], [
                    ['/usr/bin/systemctl', 'reset-failed', 'matrix-browser-runtime.service'],
                    ['/usr/bin/systemctl', 'start', '--no-block', 'matrix-browser-runtime.service']])

    def test_retry_rejects_symlinked_or_writable_native_units_before_service_calls(self):
        self.runtime.prepare()
        self.runtime.write(self.root / 'opt/matrix/release.json', '{"version":"v-test"}')
        self.runtime.write(self.runtime.prefix / 'status.json', '{"version":"v-test","status":"failed"}')
        unit = self.runtime.units / self.runtime.service_names[0]
        unit.symlink_to(self.root / 'outside')
        with patch.object(self.runtime, 'run') as run:
            with self.assertRaises(ValueError):
                self.runtime.retry()
            unit.unlink()
            self.runtime.write(unit, 'unsafe unit', 0o666)
            with self.assertRaises(ValueError):
                self.runtime.retry()
        run.assert_not_called()
        self.assertFalse((self.runtime.prefix / 'retry.json').exists())

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

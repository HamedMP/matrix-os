"""Real protected paths, disposable root Linux only; no service or network calls."""
import hashlib
import grp
import importlib.util
import json
import os
import pwd
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / 'scripts/ops/repair-funded-chat-config.py'
VERSION, SOURCE = 'v2026.10.14-fixture', 'a' * 40


@unittest.skipUnless(os.geteuid() == 0 and Path('/.dockerenv').exists(), 'disposable root Linux required')
class CommittedIdleRouting(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('MATRIX_DISPOSABLE_ROOT_TEST') != 'true' or Path('/opt/matrix').exists():
            raise RuntimeError('empty disposable fixture required')
        try:
            grp.getgrnam('matrix')
        except KeyError:
            subprocess.run(['groupadd', '-r', 'matrix'], check=True)
        try:
            pwd.getpwnam('matrix')
        except KeyError:
            subprocess.run(['useradd', '-r', '-g', 'matrix', '-M', 'matrix'], check=True)
        cls.gid, cls.uid = grp.getgrnam('matrix').gr_gid, pwd.getpwnam('matrix').pw_uid

    def setUp(self):
        for path, uid, gid, mode in [('/opt/matrix', 0, self.gid, 0o770),
            ('/opt/matrix/env', 0, self.gid, 0o750), ('/opt/matrix/app', self.uid, self.gid, 0o755),
            ('/opt/matrix/staging', self.uid, self.gid, 0o755),
            ('/opt/matrix/staging/update-transaction', 0, 0, 0o755)]:
            Path(path).mkdir(parents=True, exist_ok=True)
            os.chown(path, uid, gid)
            os.chmod(path, mode)
        self.env = Path('/opt/matrix/env/host.env')
        self.transaction = Path('/opt/matrix/staging/update-transaction')
        self.identity = {'machineId': 'fixture-machine', 'ownerId': 'user_fixture',
                         'handle': 'fixture-main', 'runtimeSlot': 'primary', 'epoch': 2}
        self.original = ('MATRIX_MACHINE_ID=fixture-machine\nMATRIX_CLERK_USER_ID=user_fixture\n'
            'MATRIX_HANDLE=fixture-main\nMATRIX_RUNTIME_SLOT=primary\nMATRIX_RUNTIME_TOKEN_EPOCH=2\n'
            'MATRIX_FUNDED_AI_ENABLED=true\nMATRIX_FUNDED_AI_RUNTIME_TOKEN=' + 'b' * 64 + '\n'
            'MATRIX_FUNDED_AI_RELAY_URL=https://old---relay.example.com\n'
            'MATRIX_FUNDED_AI_PLATFORM_URL=https://old---platform.example.com\nUNRELATED=preserved\n').encode()
        self.env.write_bytes(self.original)
        os.chown(self.env, 0, self.gid)
        os.chmod(self.env, 0o640)
        self.release = {'version': VERSION, 'gitCommit': SOURCE}
        Path('/opt/matrix/release.json').write_text(json.dumps(self.release))
        Path('/opt/matrix/app/BUNDLE_VERSION').write_text(VERSION + '\n')
        (self.transaction / 'state').write_text('mutating\n')
        (self.transaction / 'candidate-version').write_text(VERSION + '\n')
        (self.transaction / 'release-metadata').write_text(json.dumps({'version': 'v-previous', 'gitCommit': 'c' * 40}))
        (self.transaction / 'support-helper.present').touch()
        for file in self.transaction.iterdir():
            os.chmod(file, 0o644)
        info = self.env.stat()
        self.request = {'action': 'align-routing', 'rolloutId': 'fixture-route', 'identity': self.identity,
            'expectedFile': {'sha256': hashlib.sha256(self.original).hexdigest(), 'inode': info.st_ino, 'device': info.st_dev},
            'expectedRelease': self.release, 'quiescentWindow': True,
            'config': {'relayUrl': 'https://relay.example.com', 'platformUrl': 'https://platform.example.com'}}

    def tearDown(self):
        shutil.rmtree('/opt/matrix')

    def invoke(self):
        return subprocess.run(['/usr/bin/python3', '-I', str(HELPER)], input=json.dumps(self.request),
                              text=True, capture_output=True, timeout=10)

    def rejected(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertEqual(json.loads(result.stderr)['error'], 'writer_busy')
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_committed_idle_snapshot_allows_routing_and_preserves_rollback(self):
        before = {f.name: f.read_bytes() for f in self.transaction.iterdir()}
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['changed'])
        self.assertEqual({f.name: f.read_bytes() for f in self.transaction.iterdir()}, before)
        updated = self.env.read_bytes()
        self.assertIn(b'MATRIX_FUNDED_AI_RELAY_URL=https://relay.example.com\n', updated)
        self.assertIn(b'MATRIX_FUNDED_AI_RUNTIME_TOKEN=' + b'b' * 64, updated)

    def test_active_phase_rejects(self):
        Path('/opt/matrix/staging/update-phase').write_text('health\n')
        self.rejected()

    def test_incomplete_prepared_transaction_rejects(self):
        (self.transaction / 'state').write_text('prepared\n')
        self.rejected()

    def test_candidate_version_mismatch_rejects(self):
        (self.transaction / 'candidate-version').write_text('v-new-update\n')
        self.rejected()

    def test_installed_source_mismatch_rejects(self):
        Path('/opt/matrix/release.json').write_text(json.dumps({**self.release, 'gitCommit': 'd' * 40}))
        self.rejected()

    def test_bundle_version_mismatch_rejects(self):
        Path('/opt/matrix/app/BUNDLE_VERSION').write_text('v-other\n')
        self.rejected()

    def test_same_version_repair_pin_rejects(self):
        (self.transaction / 'same-version-repair.json').write_text('{}')
        self.rejected()

    def test_transaction_directory_symlink_rejects(self):
        self.transaction.rename(self.transaction.with_name('saved'))
        self.transaction.symlink_to('saved', target_is_directory=True)
        self.rejected()

    def test_state_symlink_rejects(self):
        state = self.transaction / 'state'
        state.rename(self.transaction / 'saved-state')
        state.symlink_to('saved-state')
        self.rejected()

    def test_state_hardlink_rejects(self):
        os.link(self.transaction / 'state', self.transaction / 'second-link')
        self.rejected()

    def test_active_writer_process_rejects(self):
        writer = subprocess.Popen(['matrix-update', '30'], executable='/usr/bin/sleep')
        try:
            self.rejected()
        finally:
            writer.terminate()
            writer.wait(timeout=5)

    def test_same_version_snapshot_rejects(self):
        (self.transaction / 'release-metadata').write_text(json.dumps(self.release))
        self.rejected()

    def test_update_trigger_rejects(self):
        Path('/opt/matrix/app/.update-now').touch()
        self.rejected()

    def race(self, change):
        spec = importlib.util.spec_from_file_location('repair', HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        anchor = module.open_environment('/', 0, self.gid)
        guard = module.routing_activity_guard(self.request, anchor) if hasattr(module, 'routing_activity_guard') else module.known_activity
        original_create = module.create_file

        def create(directory, name, *args, **kwargs):
            result = original_create(directory, name, *args, **kwargs)
            if name.startswith('.host.env.funded.tmp-'):
                change()
            return result

        module.create_file = create
        with self.assertRaises(module.RepairError) as raised:
            module.execute(self.request, anchor, 0, self.gid, guard)
        self.assertEqual(raised.exception.code, 'writer_busy')
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_late_phase_arrival_rejects_before_environment_rename(self):
        self.race(lambda: Path('/opt/matrix/staging/update-phase').write_text('prepare\n'))

    def test_late_state_change_rejects_before_environment_rename(self):
        self.race(lambda: (self.transaction / 'state').write_text('prepared\n'))

    def test_transaction_replacement_rejects_before_environment_rename(self):
        def replace():
            saved = self.transaction.with_name('saved')
            self.transaction.rename(saved)
            shutil.copytree(saved, self.transaction)
        self.race(replace)


if __name__ == '__main__':
    unittest.main()

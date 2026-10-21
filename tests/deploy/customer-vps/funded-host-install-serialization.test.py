"""Protected install/maintenance serialization, disposable root Linux only."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('component_fixture', Path(__file__).with_name('funded-host-component.test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
runtime, installer = fixture.runtime, fixture.installer


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').is_dir(), 'disposable root Linux only')
class InstallSerializationTests(unittest.TestCase):
    setUp = fixture.RootLifecycleTests.setUp
    tearDown = fixture.RootLifecycleTests.tearDown
    admission = fixture.RootLifecycleTests.admission

    def installed(self):
        installer.install(fixture.VERSION, fixture.SHA)
        self.state = Path(self.root + '/var/lib/matrix-funded-host-config')

    def evidence(self):
        files = [Path(self.env), Path(self.root + '/usr/local/libexec/matrix-funded-host-config.py'),
                 Path(self.root + '/etc/systemd/system/matrix-funded-host-config.service')]
        files += [p for p in self.state.iterdir() if p.suffix != '.lock']
        return {str(p): (p.read_bytes(), p.stat().st_mode) for p in files}

    def pending(self):
        state = runtime.Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
        receipt = runtime.json_bytes(state.read('receipt.json'))
        state.write('resume.json', json.dumps(runtime.resume_record(state, ['matrix-gateway.service', 'matrix-sync-agent.service'], receipt)).encode(), 0o600)
        state.close()
        self.states['matrix-gateway.service'] = 'inactive'
        self.states['matrix-sync-agent.service'] = 'inactive'

    def test_pending_restore_blocks_replacement_but_preserves_verified_noop(self):
        self.installed()
        self.pending()
        before = self.evidence()
        with self.assertRaises(installer.ConfigError):
            installer.install('v-next-repair', fixture.SHA)
        self.assertEqual(self.evidence(), before)
        self.assertFalse(any(call[0] in ('stop', 'start') for call in self.calls))
        installer.install(fixture.VERSION, fixture.SHA)
        self.assertEqual(self.evidence(), before)
        runtime.resume()
        self.assertFalse((self.state / 'resume.json').exists())
        installer.install('v-next-repair', fixture.SHA)
        self.assertEqual(json.loads((self.state / 'receipt.json').read_bytes())['version'], 'v-next-repair')
        self.assertEqual(Path(self.env).read_bytes(), self.original)

    def test_shared_maintenance_lock_blocks_install_and_invocation_consumption(self):
        self.installed()
        self.admission()
        lock_path = self.state / 'resume.lock'
        lock_path.touch(mode=0o600)
        before = self.evidence()
        with lock_path.open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                installer.install('v-next-repair', fixture.SHA)
            self.assertEqual(self.evidence(), before)
            with self.assertRaises(BlockingIOError):
                runtime.maintenance()
            self.assertEqual(self.evidence(), before)
        self.assertFalse(any(call[0] in ('stop', 'start') for call in self.calls))
        runtime.maintenance()
        self.assertIn(b'MATRIX_FUNDED_AI_ENABLED=true', Path(self.env).read_bytes())

    def test_active_maintenance_excludes_install_before_resume_journal_exists(self):
        self.installed()
        self.admission()
        original_run = runtime.run
        blocked = []
        def run(action='apply', attempt=None):
            if action == 'admit':
                before = self.evidence()
                with self.assertRaises(BlockingIOError):
                    installer.install('v-next-repair', fixture.SHA)
                self.assertEqual(self.evidence(), before)
                blocked.append(action)
            return original_run(action, attempt)
        with patch.object(runtime, 'run', run):
            runtime.maintenance()
        self.assertEqual(blocked, ['admit'])
        self.assertEqual(json.loads((self.state / 'receipt.json').read_bytes())['version'], fixture.VERSION)

    def test_install_excludes_maintenance_and_releases_locks_on_failed_fetch(self):
        self.installed()
        self.admission()
        blocked = []
        before = self.evidence()
        def failed_get(*args, **kwargs):
            with self.assertRaises(BlockingIOError):
                runtime.maintenance()
            self.assertEqual(self.evidence(), before)
            blocked.append(True)
            raise installer.ConfigError('configuration_deferred')
        with patch.object(installer, 'get', failed_get), self.assertRaises(installer.ConfigError):
            installer.install('v-next-repair', fixture.SHA)
        self.assertEqual(blocked, [True])
        self.assertEqual(self.evidence(), before)
        runtime.maintenance()
        self.assertIn(b'MATRIX_FUNDED_AI_ENABLED=true', Path(self.env).read_bytes())

    def test_install_lock_refusal_releases_maintenance_lock_for_resume(self):
        self.installed()
        before = self.evidence()
        with (self.state / 'install.lock').open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                installer.install('v-next-repair', fixture.SHA)
            self.assertEqual(self.evidence(), before)
            runtime.resume()  # No pending journal; shared maintenance lock is free.
        installer.install('v-next-repair', fixture.SHA)
        self.assertEqual(json.loads((self.state / 'receipt.json').read_bytes())['version'], 'v-next-repair')

    def test_lock_contention_releases_all_descriptors_on_repeated_deferral(self):
        self.installed()
        self.admission()
        lock_path = self.state / 'resume.lock'
        with lock_path.open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = len(os.listdir('/proc/self/fd'))
            for _ in range(20):
                for operation in (lambda: installer.install('v-next-repair', fixture.SHA), runtime.maintenance, runtime.resume):
                    with self.assertRaises(BlockingIOError):
                        operation()
            self.assertEqual(len(os.listdir('/proc/self/fd')), before)
        installer.install(fixture.VERSION, fixture.SHA)


if __name__ == '__main__':
    unittest.main()

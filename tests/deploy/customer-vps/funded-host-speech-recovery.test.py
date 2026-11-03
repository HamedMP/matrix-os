"""Recovery after the real serialized speech writer; no customer operations."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('artifact_fixture', Path(__file__).with_name('funded-host-artifact-repair.test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
runtime, installer = fixture.runtime, fixture.installer
speech = fixture.fixture.load('speech_writer', 'distro/customer-vps/host-bin/matrix-configure-platform-speech.py')


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').is_dir(), 'disposable root Linux only')
class SpeechRecoveryTests(unittest.TestCase):
    setUp = fixture.ArtifactRepairTests.setUp
    tearDown = fixture.ArtifactRepairTests.tearDown
    admission = fixture.ArtifactRepairTests.admission
    prepare = fixture.ArtifactRepairTests.prepare

    def configure(self, token='e' * 64):
        speech.apply_config(self.env, self.env + '.pre-platform-speech', {
            'machineId': self.identity['machineId'], 'runtimeSlot': 'primary',
            'enabled': True, 'origin': 'https://app.matrix-os.com', 'runtimeToken': token})

    def check_speech_recovery(self):
        self.prepare()
        self.configure()
        after = Path(self.env).read_bytes()
        applied = Path(self.root + '/var/lib/matrix-funded-host-config/applied.json')
        record = applied.read_bytes()
        self.calls.clear()
        responses = self.responses
        runtime.recovery_proof(True)
        self.configure('f' * 64)
        after = Path(self.env).read_bytes()
        runtime.recovery_proof(True)
        app = Path(self.root + '/opt/matrix/app')
        app.rename(app.with_name('app.rollback'))
        app.mkdir()
        (app / 'BUNDLE_VERSION').write_text('new-version\n')
        runtime.recovery_proof(False)
        self.assertEqual(Path(self.env).read_bytes(), after)
        self.assertEqual(applied.read_bytes(), record)
        self.assertEqual({p.name: p.read_bytes() for p in Path(self.env).parent.glob('host.env.funded-*.json')}, self.journals)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.responses, responses)

    def test_update_preflight_and_app_rollback_preserve_serialized_speech_changes(self):
        self.check_speech_recovery()

    def test_absent_epoch_recovery_preserves_serialized_speech_changes(self):
        Path(self.env).write_bytes(self.original.replace(b'MATRIX_RUNTIME_TOKEN_EPOCH=2\n', b''))
        self.check_speech_recovery()

    def test_speech_activation_from_sealed_disabled_configuration(self):
        Path(self.env).write_bytes(self.original + b'MATRIX_PLATFORM_SPEECH_ENABLED=false\n'
                b'MATRIX_PLATFORM_SPEECH_ORIGIN=https://app.matrix-os.com\n'
                b'MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=' + b'9' * 64 + b'\n')
        self.check_speech_recovery()

    def test_preflight_rejects_arbitrary_and_malformed_environment_drift(self):
        self.prepare()
        self.configure()
        good = Path(self.env).read_bytes()
        changes = (
            good + b'UNTRUSTED=1\n', good.replace(b'# preserve owner config', b'# changed comment'),
            good.replace(b'MATRIX_FUNDED_AI_ENABLED=true', b'MATRIX_FUNDED_AI_ENABLED=false'),
            good.replace(b'MATRIX_PLATFORM_SPEECH_ENABLED=true', b'MATRIX_PLATFORM_SPEECH_ENABLED=false'),
            good + b'MATRIX_PLATFORM_SPEECH_ENABLED=true\n',
            good.replace(b'MATRIX_PLATFORM_SPEECH_ENABLED=', b'export MATRIX_PLATFORM_SPEECH_ENABLED='),
            good.replace(b'MATRIX_PLATFORM_SPEECH_ENABLED=', b' MATRIX_PLATFORM_SPEECH_ENABLED='),
            good.replace(b'MATRIX_PLATFORM_SPEECH_ENABLED=true\n', b''),
            good.replace(b'https://app.matrix-os.com\nMATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN', b'http://app.matrix-os.com\nMATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN'),
            good.replace(b'MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=' + b'e' * 64, b'MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=$(id)'),
        )
        for changed in changes:
            with self.subTest(changed=changes.index(changed)):
                Path(self.env).write_bytes(changed)
                with self.assertRaises(Exception) as caught:
                    runtime.recovery_proof(True)
                self.assertIn(type(caught.exception).__name__, ('ConfigError', 'RepairError', 'ValueError'))
                self.assertEqual(Path(self.env).read_bytes(), changed)


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').is_dir(), 'disposable root Linux only')
class SpeechResealTests(unittest.TestCase):
    setUp = SpeechRecoveryTests.setUp
    tearDown = SpeechRecoveryTests.tearDown
    admission = SpeechRecoveryTests.admission
    configure = SpeechRecoveryTests.configure

    def prepare(self):
        fixture.ArtifactRepairTests.prepare(self)
        (self.transaction.parent / 'update-phase').unlink()
        shutil.rmtree(self.transaction)
        self.configure()
        self.after_speech = Path(self.env).read_bytes()
        self.applied_path = Path(self.root + '/var/lib/matrix-funded-host-config/applied.json')
        self.before_applied = self.applied_path.read_bytes()
        receipt = self.applied_path.with_name('receipt.json').read_bytes()
        info = Path(self.env).stat()
        self.request = {'receiptSha256': hashlib.sha256(receipt).hexdigest(),
                        'expectedFile': {'sha256': hashlib.sha256(self.after_speech).hexdigest(),
                                         'inode': info.st_ino, 'device': info.st_dev},
                        'quiescentWindow': True}

    def check_explicit_reseal(self):
        self.prepare()
        runtime.recovery_proof(reseal=self.request)
        self.assertEqual(self.applied_path.read_bytes(), self.before_applied)  # Dry run.
        runtime.recovery_proof(reseal=self.request, commit=True)
        applied = json.loads(self.applied_path.read_bytes())
        journal_path = next(Path(self.env).parent.glob('host.env.funded-*.json'))
        journal = json.loads(journal_path.read_bytes())
        after_reseal = Path(self.env).read_bytes()
        self.assertEqual(applied['afterSha256'], hashlib.sha256(after_reseal).hexdigest())
        self.assertEqual(journal['afterSha256'], applied['afterSha256'])
        strip = lambda value: b''.join(line for line in value.splitlines(keepends=True) if not line.startswith(b'MATRIX_PLATFORM_SPEECH_'))
        self.assertEqual(strip(after_reseal), strip(self.after_speech))
        self.assertEqual(runtime.speech_values(after_reseal), runtime.speech_values(self.after_speech))
        repair = fixture.fixture.load('resealed_repair', 'scripts/ops/repair-funded-chat-config.py')
        _, values, _ = repair.parse(after_reseal)
        fd = os.open(journal_path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            rollback = runtime.epoch_rollback_image if journal['version'] == 3 else None
            args = (fd, journal_path.name, after_reseal, values, applied['identity'], 0, 0, Path(self.env).stat())
            rolled_back = rollback(repair, *args) if rollback else repair.rollback_image(*args)
        finally:
            os.close(fd)
        self.assertEqual(rolled_back, runtime.speech_image(self.original, runtime.speech_values(self.after_speech)))
        self.refresh_guard()
        runtime.recovery_proof(reseal=self.request, commit=True)  # Idempotent.

    def test_explicit_reseal_preserves_values_and_makes_legacy_full_hash_proof_valid(self):
        self.check_explicit_reseal()

    def test_absent_epoch_reseal_preserves_original_absence_on_funded_rollback(self):
        self.original = self.original.replace(b'MATRIX_RUNTIME_TOKEN_EPOCH=2\n', b'')
        Path(self.env).write_bytes(self.original)
        self.check_explicit_reseal()

    def check_interrupted_commit(self, failure):
        self.prepare()
        real_write, real_replace = self.Directory.write, os.replace
        def fail_write(directory, name, data, mode):
            if name == failure:
                raise OSError('injected record commit interruption')
            return real_write(directory, name, data, mode)
        def fail_replace(source, target, **kwargs):
            if target == failure or (failure == 'journal' and target.startswith('host.env.funded-')):
                raise OSError('injected environment/journal commit interruption')
            return real_replace(source, target, **kwargs)
        with patch.object(self.Directory, 'write', fail_write), patch.object(os, 'replace', fail_replace), self.assertRaises(OSError):
            runtime.recovery_proof(reseal=self.request, commit=True)
        self.assertTrue(self.applied_path.with_name('speech-reseal-pending.json').exists())
        interrupted_env = Path(self.env).read_bytes()
        Path(self.env).write_bytes(interrupted_env + b'UNTRUSTED=1\n')
        self.refresh_guard()
        with self.assertRaises(installer.ConfigError):
            runtime.recovery_proof(reseal=self.request, commit=True)
        Path(self.env).write_bytes(interrupted_env)
        self.refresh_guard()
        runtime.recovery_proof(reseal=self.request, commit=True)
        self.assertFalse(self.applied_path.with_name('speech-reseal-pending.json').exists())
        self.assertEqual(runtime.speech_values(Path(self.env).read_bytes()), runtime.speech_values(self.after_speech))

    def test_interruption_before_journal_replacement_is_resumable(self):
        self.check_interrupted_commit('journal')

    def test_interruption_before_environment_replacement_is_resumable(self):
        self.check_interrupted_commit('host.env')

    def test_interruption_before_applied_record_replacement_is_resumable(self):
        self.check_interrupted_commit('applied.json')

    def test_interruption_after_all_replacements_is_resumable(self):
        self.check_interrupted_commit('speech-reseal-receipt.json')

    def refresh_guard(self):
        info = Path(self.env).stat()
        self.request['expectedFile'] = {'sha256': hashlib.sha256(Path(self.env).read_bytes()).hexdigest(),
                                        'inode': info.st_ino, 'device': info.st_dev}

    def test_reseal_rejects_stale_guards_active_update_and_unrelated_drift(self):
        self.prepare()
        for change in ('receipt', 'file', 'phase', 'drift'):
            with self.subTest(change=change):
                request = json.loads(json.dumps(self.request))
                if change == 'receipt': request['receiptSha256'] = 'b' * 64
                if change == 'file': request['expectedFile']['sha256'] = 'b' * 64
                if change == 'phase': (self.transaction.parent / 'update-phase').write_text('extract\n')
                if change == 'drift':
                    Path(self.env).write_bytes(self.after_speech + b'UNTRUSTED=1\n')
                    request['expectedFile']['sha256'] = hashlib.sha256(Path(self.env).read_bytes()).hexdigest()
                with self.assertRaises(Exception) as caught:
                    runtime.recovery_proof(reseal=request, commit=True)
                self.assertIn(type(caught.exception).__name__, ('ConfigError', 'RepairError'))
                self.assertEqual(self.applied_path.read_bytes(), self.before_applied)
                Path(self.env).write_bytes(self.after_speech)
                (self.transaction.parent / 'update-phase').unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()

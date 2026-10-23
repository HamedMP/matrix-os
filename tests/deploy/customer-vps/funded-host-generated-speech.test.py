"""Exact emitted operator entrypoint against a historical installed verifier.

Disposable root Linux only. Uses synthetic identity/configuration, real fixed
host paths and file locks; no network, service restart or customer operation.
"""
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').is_dir(), 'disposable root Linux only')
class GeneratedSpeechTests(unittest.TestCase):
    def test_old_verifier_rejects_speech_then_emitted_reseal_unblocks_preflight_and_rollback(self):
        self.assertEqual(os.environ.get('MATRIX_DISPOSABLE_ROOT_TEST'), 'true')
        self.assertTrue(Path('/.dockerenv').is_file())
        roots = ('/opt/matrix', '/var/lib/matrix-funded-host-config')
        files = ('/usr/local/libexec/matrix-funded-host-config.py', '/etc/systemd/system/matrix-funded-host-config.service')
        for value in roots + files:
            self.assertFalse(os.path.lexists(value), 'refusing an existing Matrix installation')
        def cleanup():
            for value in roots:
                shutil.rmtree(value, ignore_errors=False)
            for value in files:
                Path(value).unlink(missing_ok=True)
        self.addCleanup(cleanup)
        try:
            gid = grp.getgrnam('matrix').gr_gid
        except KeyError:
            subprocess.run(['/usr/sbin/groupadd', 'matrix'], check=True)
            gid = grp.getgrnam('matrix').gr_gid
        for value, mode, group in [('opt/matrix', 0o770, gid), ('opt/matrix/env', 0o750, gid),
                                   ('opt/matrix/staging', 0o755, gid), ('opt/matrix/app', 0o755, gid),
                                   ('var/lib/matrix-funded-host-config', 0o700, 0),
                                   ('usr/local/libexec', 0o755, 0), ('etc/systemd/system', 0o755, 0)]:
            path = Path('/') / value
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(mode)
            os.chown(path, 0, group)
        state = Path('/var/lib/matrix-funded-host-config')
        env = Path('/opt/matrix/env/host.env')
        identity = {'handle': 'speech-test', 'machineId': '12345678-1234-4234-9234-123456789012',
                    'ownerId': 'user_test', 'runtimeSlot': 'primary', 'epoch': 2}
        original = ('# preserve owner settings\nMATRIX_HANDLE=speech-test\nMATRIX_MACHINE_ID=' + identity['machineId'] +
                    '\nMATRIX_CLERK_USER_ID=user_test\nMATRIX_RUNTIME_SLOT=primary\nMATRIX_RUNTIME_TOKEN_EPOCH=2\n'
                    'MATRIX_SYNC_RUNTIME_TOKEN=' + 'd' * 64 + '\nUNRELATED="keep $literal"\n').encode()
        env.write_bytes(original)
        env.chmod(0o640)
        os.chown(env, 0, gid)
        version, source = 'v-test-legacy-speech', 'a' * 40
        release = {'version': version, 'gitCommit': source}
        Path('/opt/matrix/release.json').write_text(json.dumps(release))
        Path('/opt/matrix/release.json').chmod(0o644)
        Path('/opt/matrix/app/BUNDLE_VERSION').write_text(version + '\n')
        module = importlib.util.spec_from_file_location('repair', ROOT / 'scripts/ops/repair-funded-chat-config.py')
        repair = importlib.util.module_from_spec(module)
        module.loader.exec_module(repair)
        info = env.stat()
        result = repair.execute({'action': 'apply', 'rolloutId': 'speech-regression', 'identity': identity,
                'expectedFile': {'sha256': hashlib.sha256(original).hexdigest(), 'inode': info.st_ino, 'device': info.st_dev},
                'quiescentWindow': True, 'config': {'relayUrl': 'https://matrix-ai-relay-production-example-ey.a.run.app',
                'platformUrl': 'https://app.matrix-os.com', 'runtimeToken': 'c' * 64}},
                repair.open_environment('/', 0, gid), 0, gid, lambda: None)
        applied = {'rolloutId': 'speech-regression', 'identity': identity, 'afterSha256': result['afterSha256']}
        (state / 'applied.json').write_text(json.dumps(applied))
        (state / 'applied.json').chmod(0o600)
        repair_source = (ROOT / 'scripts/ops/repair-funded-chat-config.py').read_text()
        legacy = '\n'.join((ROOT / ('distro/customer-vps/funded-host-config/' + name)).read_text()
                           for name in ('install.py', 'reconcile.py', 'epoch.py'))
        # Snapshot is the verifier shipped before ENG-345, unchanged from
        # f1f911d8b. This regression must not silently test the new proof twice.
        legacy += '\n' + (ROOT / 'tests/deploy/customer-vps/fixtures/funded-recovery-v1.py').read_text()
        legacy += '\nREPAIR_SOURCE = ' + repr(repair_source) + '\nrecovery_proof(sys.argv[1] == "--recovery-preflight")\n'
        installed = Path(files[0])
        installed.write_text(legacy)
        installed.chmod(0o644)
        unit = (ROOT / 'distro/customer-vps/funded-host-config/matrix-funded-host-config.service').read_bytes()
        Path(files[1]).write_bytes(unit)
        Path(files[1]).chmod(0o644)
        receipt = {'version': version, 'sourceSha': source, 'archiveSha256': 'b' * 64,
                   'componentSha256': hashlib.sha256(legacy.encode()).hexdigest(), 'unitSha256': hashlib.sha256(unit).hexdigest()}
        (state / 'receipt.json').write_text(json.dumps(receipt))
        (state / 'receipt.json').chmod(0o600)
        (state / 'install.lock').touch(mode=0o600)
        (state / 'resume.lock').touch(mode=0o600)
        def transaction():
            staging = Path('/opt/matrix/staging')
            (staging / 'update-phase').write_text('extract\n')
            (staging / 'update-phase').chmod(0o600)
            directory = staging / 'update-transaction'
            directory.mkdir(mode=0o755)
            for name, value in [('state', 'mutating\n'), ('candidate-version', 'v-test-candidate\n'),
                                ('release-metadata', json.dumps(release))]:
                (directory / name).write_text(value)
                (directory / name).chmod(0o644)
        def proof(preflight=True):
            return subprocess.run(['python3', '-I', str(installed), '--recovery-preflight' if preflight else '--recovery-check'],
                                  capture_output=True, timeout=10)
        transaction()
        self.assertEqual(proof().returncode, 0)
        config = {'machineId': identity['machineId'], 'runtimeSlot': 'primary', 'enabled': True,
                  'origin': 'https://app.matrix-os.com', 'runtimeToken': 'e' * 64}
        configured = subprocess.run(['python3', '-I', str(ROOT / 'distro/customer-vps/host-bin/matrix-configure-platform-speech.py')],
                                    input=json.dumps(config).encode(), capture_output=True, timeout=10)
        self.assertEqual(configured.returncode, 0, configured.stderr)
        before_reseal = env.read_bytes()
        self.assertNotEqual(proof().returncode, 0)
        shutil.rmtree('/opt/matrix/staging/update-transaction')
        Path('/opt/matrix/staging/update-phase').unlink()
        with tempfile.TemporaryDirectory() as temporary:
            agent = Path(temporary) / 'matrix-sync-agent'
            agent.write_bytes((ROOT / 'distro/customer-vps/host-bin/matrix-sync-agent').read_bytes())
            subprocess.run(['node', str(ROOT / 'scripts/prepare-funded-host-component.mjs'), str(agent),
                            str(Path(temporary) / 'component')], check=True, capture_output=True, timeout=10)
            operator = Path(temporary) / 'matrix-reseal-funded-speech.py'
            info = env.stat()
            request = {'receiptSha256': hashlib.sha256((state / 'receipt.json').read_bytes()).hexdigest(),
                       'expectedFile': {'sha256': hashlib.sha256(env.read_bytes()).hexdigest(),
                                        'inode': info.st_ino, 'device': info.st_dev}, 'quiescentWindow': True}
            def reseal(action):
                return subprocess.run(['python3', '-I', str(operator), action], input=json.dumps(request).encode(),
                                      capture_output=True, timeout=10)
            checked = reseal('--check')
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertEqual(env.read_bytes(), before_reseal)
            committed = reseal('--apply')
            self.assertEqual(committed.returncode, 0, committed.stderr)
        self.assertEqual((state / 'receipt.json').read_text(), json.dumps(receipt))
        self.assertEqual(installed.read_text(), legacy)
        after_reseal = env.read_bytes()
        strip = lambda data: b''.join(line for line in data.splitlines(keepends=True) if not line.startswith(b'MATRIX_PLATFORM_SPEECH_'))
        self.assertEqual(strip(before_reseal), strip(after_reseal))
        self.assertEqual((env.stat().st_uid, env.stat().st_gid, env.stat().st_mode & 0o777), (0, gid, 0o640))
        transaction()
        admitted = proof()
        self.assertEqual(admitted.returncode, 0, admitted.stderr)
        self.assertEqual(admitted.stdout.strip(), b'current')
        Path('/opt/matrix/app').rename('/opt/matrix/app.rollback')
        Path('/opt/matrix/app').mkdir()
        Path('/opt/matrix/app/BUNDLE_VERSION').write_text('v-test-candidate\n')
        restored = proof(False)
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertEqual(restored.stdout.strip(), b'rollback')
        self.assertEqual(env.read_bytes(), after_reseal)


if __name__ == '__main__':
    unittest.main()

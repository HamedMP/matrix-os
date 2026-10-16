"""Portable protected-file contracts; no host, database or provider operations."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]

def load(path):
    namespace = {'__name__': 'sync_initialization_test'}
    exec(compile((ROOT / path).read_text(), path, 'exec'), namespace)
    return namespace

REPAIR = type('Repair', (), load('scripts/ops/repair-funded-chat-config.py'))
NS = load('distro/customer-vps/funded-host-config/install.py')
for part in ('reconcile.py', 'epoch.py'):
    exec(compile((ROOT / 'distro/customer-vps/funded-host-config' / part).read_text(), part, 'exec'), NS)
source = ROOT / 'distro/customer-vps/funded-host-config/sync-initialization.py'
if source.exists():
    exec(compile(source.read_text(), str(source), 'exec'), NS)

class SyncInitializationTests(unittest.TestCase):
    def setUp(self):
        self.initialize = NS.get('initialize_scoped_sync')
        self.assertTrue(callable(self.initialize), 'protected Sync-only initialization mode is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        for part, mode in [('opt', 0o755), ('opt/matrix', 0o770), ('opt/matrix/env', 0o750)]:
            os.mkdir(self.root + '/' + part, mode); os.chmod(self.root + '/' + part, mode)
        self.path = Path(self.root + '/opt/matrix/env/host.env')
        self.identity = {'machineId': '12345678-1234-4234-9234-123456789012', 'ownerId': 'user_test',
                         'handle': 'test-main', 'runtimeSlot': 'primary', 'runtimeTokenEpoch': 2}
        self.old = ('MATRIX_MACHINE_ID=' + self.identity['machineId'] + '\nMATRIX_CLERK_USER_ID=user_test\n'
                    'MATRIX_HANDLE=test-main\nMATRIX_RUNTIME_SLOT=primary\nPLATFORM_INTERNAL_URL=https://app.matrix-os.com\n'
                    'UPGRADE_TOKEN=' + 'e' * 64 + '\nUNRELATED="$keep"\n').encode()
        self.path.write_bytes(self.old); os.chmod(self.path, 0o640)
        self.anchor = REPAIR.open_environment(self.root, os.getuid(), os.getgid())
        self.addCleanup(self.anchor.close)
        self.recipient = 'd' * 64
        self.now = 1792152000.0  # 2026-10-16T12:00:00Z
        self.payload = self.request()
        self.calls = []

    def request(self):
        info = self.path.stat()
        return {'contractVersion': 1, 'kind': 'matrix-sync-initialization', 'identity': dict(self.identity),
                'expectedRelease': {'version': 'v-test-sync-init', 'gitCommit': 'a' * 40},
                'expectedFile': {'sha256': hashlib.sha256(self.path.read_bytes()).hexdigest(),
                                 'inode': info.st_ino, 'device': info.st_dev},
                'recipientSha256': self.recipient, 'issuedAt': '2026-10-16T12:00:00.000Z',
                'expiresAt': '2026-10-16T12:00:30.000Z', 'nonce': 'c' * 32, 'syncRuntimeToken': 'b' * 64}

    def proof(self, path, headers):
        self.calls.append((path, headers))
        return json.dumps({'contractVersion': 1, 'kind': 'matrix-funded-host-epoch', 'source': 'platform',
                           'sourceSha': 'a' * 40, 'issuedAt': '2026-10-16T12:00:00.000Z',
                           'expiresAt': '2026-10-16T12:00:30.000Z', 'identity': self.identity}).encode()

    def apply(self, activity=lambda: None, proof=None):
        return self.initialize(REPAIR, self.anchor, self.payload, self.recipient, proof or self.proof,
                               activity, self.now, os.getuid(), os.getgid())

    def test_only_missing_sync_is_inserted_after_strict_current_metadata_proof(self):
        result = self.apply()
        after = self.path.read_bytes()
        self.assertEqual(after, self.old + b'MATRIX_SYNC_RUNTIME_TOKEN=' + b'b' * 64 + b'\n')
        self.assertTrue(result['changed']); self.assertFalse(result['restartRequired'])
        self.assertNotIn(b'MATRIX_RUNTIME_TOKEN_EPOCH=', after)
        self.assertNotIn(b'MATRIX_FUNDED_AI_', after); self.assertNotIn(b'MATRIX_PLATFORM_SPEECH_', after)
        self.assertEqual(self.calls[0], ('/internal/containers/test-main/funded-host-epoch', {
            'Authorization': 'Bearer ' + 'b' * 64, 'x-matrix-machine-id': self.identity['machineId'],
            'x-matrix-runtime-slot': 'primary'}))
        self.assertNotIn('x-matrix-runtime-token-epoch', self.calls[0][1])
        journal = json.loads(self.path.with_name(result['backup']).read_bytes())
        self.assertEqual(base64.b64decode(journal['original']), self.old)
        self.assertEqual(self.path.with_name(result['backup']).stat().st_mode & 0o777, 0o600)
        self.assertEqual(journal['afterSha256'], hashlib.sha256(after).hexdigest())

    def test_current_local_epoch_is_preserved_without_rotation(self):
        self.path.write_bytes(self.old + b'MATRIX_RUNTIME_TOKEN_EPOCH=2\n'); self.payload = self.request()
        before = self.path.read_bytes(); self.apply()
        self.assertEqual(self.path.read_bytes(), before + b'MATRIX_SYNC_RUNTIME_TOKEN=' + b'b' * 64 + b'\n')

    def test_present_malformed_export_quoted_or_duplicate_assignment_is_never_overwritten(self):
        for extra in (b'MATRIX_SYNC_RUNTIME_TOKEN=old\n', b'export MATRIX_SYNC_RUNTIME_TOKEN=old\n',
                      b' MATRIX_SYNC_RUNTIME_TOKEN = old\n', b'MATRIX_SYNC_RUNTIME_TOKEN="' + b'b'*64 + b'"\n',
                      b'MATRIX_SYNC_RUNTIME_TOKEN=\nMATRIX_SYNC_RUNTIME_TOKEN=\n'):
            with self.subTest(extra=extra):
                self.path.write_bytes(self.old + extra); self.payload = self.request()
                with self.assertRaises(Exception): self.apply()
                self.assertEqual(self.path.read_bytes(), self.old + extra)

    def test_identity_epoch_source_recipient_and_freshness_are_fail_closed(self):
        variants = [dict(self.payload, kind='matrix-runtime-rotation'), dict(self.payload, recipientSha256='f'*64),
                    dict(self.payload, expiresAt='2026-10-16T12:00:31.000Z'),
                    dict(self.payload, issuedAt='2026-10-16T12:00:01.000Z'),
                    dict(self.payload, identity=dict(self.identity, ownerId='other')),
                    dict(self.payload, identity=dict(self.identity, runtimeSlot='secondary')),
                    dict(self.payload, expectedRelease={'version':'v-test-sync-init','gitCommit':'bad'}),
                    dict(self.payload, nonce='bad'), dict(self.payload, fundedAi='must-not-be-accepted')]
        for payload in variants:
            with self.subTest(payload=payload):
                self.payload = payload
                with self.assertRaises(Exception): self.apply()
                self.assertEqual(self.path.read_bytes(), self.old)
        self.path.write_bytes(self.old + b'MATRIX_RUNTIME_TOKEN_EPOCH=1\n'); self.payload = self.request()
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), self.old + b'MATRIX_RUNTIME_TOKEN_EPOCH=1\n')

    def test_denied_expired_source_or_rotated_epoch_proof_never_publishes(self):
        original = self.payload
        def denied(_path, _headers): raise NS['ConfigError']('configuration_deferred')
        proofs = [denied]
        for change in ({'sourceSha': 'f'*40}, {'expiresAt': '2026-10-16T12:00:00.000Z'},
                       {'identity': dict(self.identity, runtimeTokenEpoch=3)},
                       {'identity': dict(self.identity, ownerId='other')}, {'configuration': {}}):
            def altered(path, headers, change=change):
                response = json.loads(self.proof(path, headers)); response.update(change)
                return json.dumps(response).encode()
            proofs.append(altered)
        for proof in proofs:
            with self.subTest(proof=proof):
                self.payload = original
                with self.assertRaises(Exception): self.apply(proof=proof)
                self.assertEqual(self.path.read_bytes(), self.old)

    def test_shared_writer_lock_is_required(self):
        lock = os.open(self.path.with_name('.host.env.funded-repair.lock'), os.O_RDWR|os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(Exception): self.apply()
            self.assertEqual(self.path.read_bytes(), self.old)
        finally: os.close(lock)

    def test_cas_and_ancestor_rebinding_cannot_publish(self):
        def race(): self.path.write_bytes(self.old + b'LATER=keep\n')
        with self.assertRaises(Exception): self.apply(activity=race)
        self.assertEqual(self.path.read_bytes(), self.old + b'LATER=keep\n')
        self.path.write_bytes(self.old); self.payload = self.request()
        def rebind():
            if not Path(self.root + '/original').exists():
                os.rename(self.path.parent, self.root + '/original'); os.symlink(self.root + '/original', self.path.parent)
        with self.assertRaises(Exception): self.apply(activity=rebind)
        self.assertEqual(Path(self.root + '/original/host.env').read_bytes(), self.old)

    def test_rename_failure_keeps_original_and_exclusive_journal(self):
        with patch.object(os, 'replace', side_effect=OSError('injected failure')), self.assertRaises(OSError): self.apply()
        self.assertEqual(self.path.read_bytes(), self.old)
        journals = list(self.path.parent.glob('.host.env.sync-init-*.json'))
        self.assertEqual(len(journals), 1)
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), self.old)

    def test_replay_and_later_credential_conflict_do_not_replace_anything(self):
        self.apply(); after = self.path.read_bytes()
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), after)
        self.path.write_bytes(after.replace(b'b'*64, b'f'*64))
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), after.replace(b'b'*64, b'f'*64))

if __name__ == '__main__': unittest.main()

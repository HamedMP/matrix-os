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
        release = self.path.parent.parent / 'release.json'
        release.write_text(json.dumps({'version': 'v-test-sync-init', 'gitCommit': 'a' * 40})); os.chmod(release, 0o644)
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

    def test_supported_api_fallback_is_preserved_but_proof_uses_the_same_fixed_route(self):
        before = self.old.replace(b'PLATFORM_INTERNAL_URL=https://app.matrix-os.com',
                                  b'PLATFORM_INTERNAL_URL=https://api.matrix-os.com')
        self.path.write_bytes(before); self.payload = self.request()
        self.apply()
        self.assertEqual(self.path.read_bytes(), before + b'MATRIX_SYNC_RUNTIME_TOKEN=' + b'b'*64 + b'\n')
        self.assertEqual(self.calls[0][0], '/internal/containers/test-main/funded-host-epoch')

    def test_nonproduction_fallback_and_noncanonical_dedicated_platform_defer_unchanged(self):
        for fallback in (b'https://preview.matrix-os.com', b'https://api.matrix-os.com.evil.example', b'http://api.matrix-os.com'):
            before = self.old.replace(b'https://app.matrix-os.com', fallback)
            self.path.write_bytes(before); self.payload = self.request()
            with self.assertRaises(Exception): self.apply()
            self.assertEqual(self.path.read_bytes(), before)
            self.assertFalse(self.calls)
        # The existing dedicated funding configuration contract remains canonical app-only.
        before = self.old + b'MATRIX_FUNDED_AI_PLATFORM_URL=https://api.matrix-os.com\n'
        self.path.write_bytes(before); self.payload = self.request()
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(self.calls)

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

    def test_network_delay_uses_elapsed_time_and_rejects_expiry_before_publication(self):
        elapsed = [100.0]
        def late_proof(path, headers):
            elapsed[0] += 31
            return self.proof(path, headers)
        with patch.object(NS['time'], 'monotonic', side_effect=lambda: elapsed[0]), self.assertRaises(Exception):
            self.apply(proof=late_proof)
        self.assertEqual(self.path.read_bytes(), self.old)
        def current_later_proof(path, headers):
            elapsed[0] += 5
            response = json.loads(self.proof(path, headers))
            response.update(issuedAt='2026-10-16T12:00:05.000Z', expiresAt='2026-10-16T12:00:25.000Z')
            return json.dumps(response).encode()
        elapsed[0] = 100.0
        with patch.object(NS['time'], 'monotonic', side_effect=lambda: elapsed[0]): self.apply(proof=current_later_proof)
        self.assertIn(b'MATRIX_SYNC_RUNTIME_TOKEN=', self.path.read_bytes())

    def test_expiry_at_final_guard_and_release_change_do_not_publish(self):
        elapsed, calls = [100.0], [0]
        def expire():
            calls[0] += 1
            if calls[0] == 2: elapsed[0] += 31
        with patch.object(NS['time'], 'monotonic', side_effect=lambda: elapsed[0]), self.assertRaises(Exception):
            self.apply(activity=expire)
        self.assertEqual(self.path.read_bytes(), self.old)
        # Preserve the failed attempt's journal; a distinct reviewed attempt tests source CAS.
        self.payload['nonce'] = 'e' * 32
        def change_release():
            release = self.path.parent.parent / 'release.json'
            release.write_text(json.dumps({'version': 'another-version', 'gitCommit': 'a' * 40}))
        with self.assertRaises(Exception): self.apply(activity=change_release)
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

    def test_final_size_and_journal_count_are_bounded(self):
        before = self.old + b'FILL=' + b'x' * (REPAIR.LIMIT - len(self.old) - 6) + b'\n'
        self.path.write_bytes(before); self.payload = self.request()
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(list(self.path.parent.glob('.host.env.sync-init-*.json')))
        self.path.write_bytes(self.old); self.payload = self.request()
        for index in range(32):
            journal = self.path.with_name('.host.env.sync-init-' + format(index, '032x') + '.json')
            journal.write_bytes(b'previous evidence'); journal.chmod(0o600)
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), self.old)

    def test_rename_failure_keeps_original_and_exclusive_journal(self):
        with patch.object(os, 'replace', side_effect=OSError('injected failure')), self.assertRaises(OSError): self.apply()
        self.assertEqual(self.path.read_bytes(), self.old)
        journals = list(self.path.parent.glob('.host.env.sync-init-*.json'))
        self.assertEqual(len(journals), 1)
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), self.old)

    def test_post_rename_fsync_failure_preserves_committed_image_and_blocks_blind_replay(self):
        replace, fsync = os.replace, os.fsync
        committed = False

        def commit(*args, **kwargs):
            nonlocal committed
            replace(*args, **kwargs)
            committed = True

        def fail_after_commit(fd):
            if committed:
                raise OSError('injected post-rename fsync failure')
            fsync(fd)

        with patch.object(os, 'replace', commit), patch.object(os, 'fsync', fail_after_commit):
            with self.assertRaises(OSError): self.apply()
        after = self.old + b'MATRIX_SYNC_RUNTIME_TOKEN=' + b'b' * 64 + b'\n'
        self.assertEqual(self.path.read_bytes(), after)
        journals = list(self.path.parent.glob('.host.env.sync-init-*.json'))
        self.assertEqual(len(journals), 1)
        journal = json.loads(journals[0].read_bytes())
        self.assertEqual(base64.b64decode(journal['original']), self.old)
        self.assertEqual(journal['afterSha256'], hashlib.sha256(after).hexdigest())
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), after)
        self.assertEqual(list(self.path.parent.glob('.host.env.sync-init-*.json')), journals)
        rollback = NS['sync_initialization_rollback_image']
        self.assertEqual(rollback(REPAIR, self.anchor.fds[-1], journals[0].name, after,
                                  self.identity, os.getuid(), os.getgid()), self.old)

    def test_rollback_image_preserves_unrelated_edits_and_refuses_token_or_funding_conflict(self):
        result = self.apply(); after = self.path.read_bytes()
        rollback = NS['sync_initialization_rollback_image']
        args = (REPAIR, self.anchor.fds[-1], result['backup'])
        self.assertEqual(rollback(*args, after, self.identity, os.getuid(), os.getgid()), self.old)
        self.assertEqual(rollback(*args, after + b'LATER=keep\n', self.identity, os.getuid(), os.getgid()),
                         self.old + b'LATER=keep\n')
        for changed in (after.replace(b'b'*64, b'f'*64), after + b'MATRIX_RUNTIME_TOKEN_EPOCH=2\n',
                        after + b'MATRIX_FUNDED_AI_ENABLED=true\n'):
            with self.assertRaises(Exception): rollback(*args, changed, self.identity, os.getuid(), os.getgid())

    def test_input_and_key_are_pinned_private_regular_single_link_files(self):
        state_path = Path(self.root + '/state'); state_path.mkdir(mode=0o700)
        class State:
            fds = [os.open(state_path, os.O_RDONLY | os.O_DIRECTORY)]
            def verify(inner):
                self.assertEqual(os.fstat(inner.fds[-1]).st_ino, state_path.lstat().st_ino)
        state = State(); self.addCleanup(os.close, state.fds[-1])
        envelope = state_path / NS['SYNC_ENVELOPE_NAME']
        key = self.path.with_name(NS['SYNC_KEY_NAME'])
        envelope.write_bytes(b'ciphertext'); envelope.chmod(0o600)
        key.write_bytes(b'private key fixture'); key.chmod(0o600)
        read_inputs = lambda: NS['read_sync_initialization_inputs'](REPAIR, state, self.anchor, os.getuid())
        self.assertEqual(read_inputs(), (b'ciphertext', b'private key fixture'))
        for candidate in (envelope, key):
            candidate.chmod(0o640)
            with self.assertRaises(Exception): read_inputs()
            candidate.chmod(0o600)
            saved = candidate.with_suffix('.saved'); candidate.rename(saved); candidate.symlink_to(saved)
            with self.assertRaises(Exception): read_inputs()
            candidate.unlink(); saved.rename(candidate)
            link = candidate.with_suffix('.linked'); os.link(candidate, link)
            with self.assertRaises(Exception): read_inputs()
            link.unlink()
        key.write_bytes(b'x' * 8193)
        with self.assertRaises(Exception): read_inputs()

    def test_replay_and_later_credential_conflict_do_not_replace_anything(self):
        self.apply(); after = self.path.read_bytes()
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), after)
        self.path.write_bytes(after.replace(b'b'*64, b'f'*64))
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.path.read_bytes(), after.replace(b'b'*64, b'f'*64))

if __name__ == '__main__': unittest.main()

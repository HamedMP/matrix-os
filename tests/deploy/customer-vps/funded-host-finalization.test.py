"""Actual emitted finalizers over root FDs in disposable network-none Linux.

Systemctl/health are mocks; artifact hashes, sealed pins, phase retirement and
archive cleanup execute the emitted source over real protected filesystem paths.
"""
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
VERSION, SOURCE = 'v-test-finalization', 'a' * 40

@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').exists(), 'requires disposable root Linux')
class FinalizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('MATRIX_DISPOSABLE_ROOT_TEST') != 'true' or not Path('/.dockerenv').is_file():
            raise RuntimeError('disposable container required')
        for path in ('/opt/matrix', '/var/lib/matrix-funded-host-config', '/usr/local/libexec/matrix-funded-host-config.py'):
            if Path(path).exists():
                raise RuntimeError('fixture roots must be empty')
        try:
            grp.getgrnam('matrix')
        except KeyError:
            subprocess.run(['/usr/sbin/groupadd', 'matrix'], check=True)
            subprocess.run(['/usr/sbin/useradd', '-M', '-g', 'matrix', 'matrix'], check=True)
        cls.build = tempfile.TemporaryDirectory()
        agent, component = Path(cls.build.name) / 'agent', Path(cls.build.name) / 'component'
        shutil.copyfile(ROOT / 'distro/customer-vps/host-bin/matrix-sync-agent', agent)
        subprocess.run(['node', str(ROOT / 'scripts/prepare-funded-host-component.mjs'), str(agent), str(component)], check=True)
        subprocess.run(['node', str(ROOT / 'scripts/inline-sync-agent-recovery.mjs'), str(agent),
                        *[str(ROOT / ('distro/customer-vps/host-bin/' + name)) for name in
                          ('matrix-sync-agent-recovery', 'matrix-update-manifest', 'matrix-update-request-rejection')]], check=True)
        cls.emitted, cls.code, cls.unit = agent.read_text(), (component / 'reconcile.py').read_bytes(), (component / 'matrix-funded-host-config.service').read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        gid = grp.getgrnam('matrix').gr_gid
        for path, mode, group in (('/opt/matrix', 0o770, gid), ('/opt/matrix/app', 0o755, gid),
            ('/opt/matrix/env', 0o750, gid), ('/opt/matrix/staging', 0o755, gid),
            ('/opt/matrix/staging/update-transaction', 0o755, 0),
            ('/var/lib/matrix-funded-host-config', 0o700, 0), ('/usr/local/libexec', 0o755, 0)):
            Path(path).mkdir(parents=True, exist_ok=True)
            os.chown(path, 0, group)
            os.chmod(path, mode)
        self.transaction = Path('/opt/matrix/staging/update-transaction')
        self.phase = Path('/opt/matrix/staging/update-phase')
        self.archive = Path('/opt/matrix/staging/bundle-' + VERSION + '.tar.gz')
        self.archive.write_bytes(b'exact prior checksum-verified fixture archive')
        self.env = Path('/opt/matrix/env/host.env')
        self.original = b'UNRELATED=preserved\nMATRIX_FUNDED_AI_ENABLED=true\n'
        self.env.write_bytes(self.original)
        os.chown(self.env, 0, gid)
        os.chmod(self.env, 0o640)
        Path('/opt/matrix/app/BUNDLE_VERSION').write_text(VERSION + '\n')
        release = json.dumps({'version': VERSION, 'gitCommit': SOURCE}).encode()
        Path('/opt/matrix/release.json').write_bytes(release)
        os.chmod('/opt/matrix/release.json', 0o644)
        (self.transaction / 'release-metadata').write_bytes(release)
        (self.transaction / 'state').write_bytes(b'mutating\n')
        (self.transaction / 'candidate-version').write_text(VERSION + '\n')
        self.phase.write_bytes(b'extract\n')
        os.chmod(self.phase, 0o600)
        Path('/usr/local/libexec/matrix-funded-host-config.py').write_bytes(self.code)
        Path('/etc/systemd/system').mkdir(parents=True, exist_ok=True)
        Path('/etc/systemd/system/matrix-funded-host-config.service').write_bytes(self.unit)
        self.receipt = {'version': VERSION, 'sourceSha': SOURCE, 'archiveSha256': hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                        'componentSha256': hashlib.sha256(self.code).hexdigest(), 'unitSha256': hashlib.sha256(self.unit).hexdigest()}
        self.state = Path('/var/lib/matrix-funded-host-config')
        (self.state / 'receipt.json').write_text(json.dumps(self.receipt))
        (self.state / 'install.lock').touch(mode=0o600)
        self.applied = json.dumps({'rolloutId': 'repair-' + 'b' * 32, 'identity': {'handle': 'fixture-main'},
                                   'afterSha256': hashlib.sha256(self.original).hexdigest()}).encode()
        (self.state / 'applied.json').write_bytes(self.applied)
        info = Path('/opt/matrix/app').stat()
        self.pin = self.transaction / 'same-version-repair.json'
        self.pin.write_text(json.dumps({'kind': 'matrix-same-version-artifact-repair', 'contractVersion': 1,
            'receipt': self.receipt, 'appDevice': info.st_dev, 'appInode': info.st_ino}))
        for file in self.transaction.iterdir():
            os.chmod(file, 0o644)

    def tearDown(self):
        shutil.rmtree('/opt/matrix')
        shutil.rmtree('/var/lib/matrix-funded-host-config')
        Path('/usr/local/libexec/matrix-funded-host-config.py').unlink()
        Path('/etc/systemd/system/matrix-funded-host-config.service').unlink()

    def shell(self, command, fault=''):
        helpers = '\n'.join(re.search(name + r'\(\) \{[\s\S]*?\n\}', self.emitted).group(0)
                            for name in ('cleanup_update_transaction', 'preserve_host_rollback_transaction', 'clean_staging', 'clean_staging_now', 'apply_update'))
        library = self.emitted.split('# BEGIN inlined update recovery library\n', 1)[1].split('# END inlined update recovery library', 1)[0]
        source = helpers + '\n' + library + r'''
APP_DIR=/opt/matrix/app
STAGING_DIR=/opt/matrix/staging
RELEASE_FILE=/opt/matrix/release.json
UPDATE_TRANSACTION_DIR=$STAGING_DIR/update-transaction
UPDATE_TRANSACTION_STATE=$UPDATE_TRANSACTION_DIR/state
UPDATE_PHASE_MARKER=$STAGING_DIR/update-phase
UPDATE_MARKER=$APP_DIR/.update-available.json
STAGING_ARTIFACT_TTL_SECONDS=60
log() { echo "$*" >&2; }
current_version() { cat "$APP_DIR/BUNDLE_VERSION"; }
write_update_error() { echo "error:$1"; }
resume_update_transaction_services() { [ "$FAULT" != resume ]; }
resume_symphony_after_update() { :; }
terminal_runtime_is_healthy() { [ "$FAULT" != health ]; }
running_gateway_version() { current_version; }
sudo() {
 if [ "$1" = systemctl ]; then return 0; fi
 if [ "$1" = /usr/bin/timeout ] && [ "$FAULT" = phase-unlink -o "$FAULT" = phase-fsync -o "$FAULT" = phase-fsync-shortwrite -o "$FAULT" = phase-link-death -o "$FAULT" = rename -o "$FAULT" = death-before-rename ]; then
  local source
  source="$(cat)"
  case "$source" in *'confirmed update phase retirement deferred'*)
   printf '%s\n' "$source" | /usr/bin/python3 -I -c '
import os,sys
unlink,fsync,rename,write,link=os.unlink,os.fsync,os.rename,os.write,os.link
count=0
def injected_unlink(name,**kw):
 if os.environ["FAULT"]=="phase-unlink": raise OSError("injected")
 return unlink(name,**kw)
def injected_fsync(fd):
 global count
 count+=1
 if os.environ["FAULT"] in ("phase-fsync", "phase-fsync-shortwrite", "phase-link-death") and count==2: raise OSError("injected")
 return fsync(fd)
def injected_write(fd,data):
 if os.environ["FAULT"]=="phase-fsync-shortwrite": return write(fd,data[:1])
 return write(fd,data)
def injected_link(*args,**kw):
 result=link(*args,**kw)
 if os.environ["FAULT"]=="phase-link-death": os._exit(77)
 return result
def injected_rename(*args,**kw):
 if os.environ["FAULT"]=="death-before-rename": os._exit(77)
 if os.environ["FAULT"]=="rename": raise OSError("injected")
 return rename(*args,**kw)
os.unlink,os.fsync,os.rename,os.write,os.link=injected_unlink,injected_fsync,injected_rename,injected_write,injected_link
exec(compile(sys.stdin.read(),"<actual-emitted-finalizer-with-fault>","exec"))'
   return $?;;
  esac
  printf '%s\n' "$source" | command "$@"; return $?
 fi
 command "$@"
}
'''
        if fault == 'preserve':
            source += '\npreserve_host_rollback_transaction() { return 1; }\n'
        return subprocess.run(['bash', '-c', source + '\n' + command], env={**os.environ, 'FAULT': fault}, capture_output=True, timeout=15)

    def assert_unchanged(self):
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertEqual((self.state / 'applied.json').read_bytes(), self.applied)

    def assert_blocked_and_retained(self):
        self.assertTrue(self.phase.exists())
        self.assertTrue(self.transaction.exists())
        before = self.archive.read_bytes()
        os.utime(self.archive, (1, 1))
        for command in ('clean_staging', 'clean_staging_now'):
            result = self.shell(command)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(self.archive.read_bytes(), before)
        Path('/opt/matrix/app/.update-available.json').write_bytes(b'{}')
        result = self.shell('apply_update explicit')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'error:post_install_rollback_failed', result.stdout)
        self.assertNotIn(b'Starting update', result.stderr)
        self.assert_unchanged()

    def test_confirmed_prestop_retires_only_pin_and_phase(self):
        result = self.shell('finish_unmutated_update_transaction')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertFalse(self.phase.exists())
        self.assertFalse(self.pin.exists())
        self.assertTrue((self.transaction / 'release-metadata').exists())
        self.assert_unchanged()

    def test_phase_failures_preserve_exact_snapshot_and_archive(self):
        for fault in ('phase-unlink', 'phase-fsync', 'phase-fsync-shortwrite', 'preserve', 'phase-link-death'):
            with self.subTest(fault=fault):
                before = self.phase.read_bytes()
                if fault == 'phase-link-death':
                    os.chown(self.phase.parent, 0, grp.getgrnam('matrix').gr_gid)
                    os.chmod(self.phase.parent, 0o2775)
                result = self.shell('finish_unmutated_update_transaction', fault)
                self.assertEqual(result.returncode, 77 if fault == 'phase-link-death' else 1, result.stderr.decode())
                self.assertEqual(self.phase.read_bytes(), before)
                temporary = self.phase.with_name('.update-phase-retirement-restore')
                self.assertEqual(temporary.exists(), fault == 'phase-link-death')
                if temporary.exists():
                    self.assertEqual(temporary.stat().st_ino, self.phase.stat().st_ino)
                    self.assertEqual(self.phase.stat().st_nlink, 2)
                self.assert_blocked_and_retained()

    def test_failed_restoration_or_health_defers_before_retirement(self):
        for fault in ('resume', 'health'):
            with self.subTest(fault=fault):
                result = self.shell('resume_unmutated_update_transaction', fault)
                self.assertEqual(result.returncode, 1, result.stderr.decode())
                self.assertTrue(self.pin.exists())
                self.assert_blocked_and_retained()

    def test_current_metadata_conflict_defers(self):
        Path('/opt/matrix/release.json').write_text(json.dumps({'version': VERSION, 'gitCommit': 'c' * 40}))
        result = self.shell('finish_unmutated_update_transaction')
        self.assertEqual(result.returncode, 1)
        self.assertTrue(self.pin.exists())
        self.assert_blocked_and_retained()

    def test_invalid_pin_cannot_retire_or_grant_retry(self):
        self.pin.write_bytes(b'{}')
        result = self.shell('finish_unmutated_update_transaction')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.pin.read_bytes(), b'{}')
        self.assert_blocked_and_retained()

    def newer_candidate(self):
        self.pin.unlink()
        candidate = VERSION + '-failed-next'
        (self.transaction / 'candidate-version').write_text(candidate + '\n')
        self.archive.rename('/opt/matrix/staging/bundle-' + candidate + '.tar.gz')
        self.archive = Path('/opt/matrix/staging/bundle-' + candidate + '.tar.gz')
        self.phase.write_bytes(b'health\n')
        return candidate

    def test_completed_newer_snapshot_moves_without_rewriting_provenance(self):
        candidate = self.newer_candidate()
        result = self.shell('finish_unmutated_update_transaction')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        completed = Path('/opt/matrix/staging/update-transaction.completed')
        self.assertFalse(self.transaction.exists())
        self.assertFalse(self.phase.exists())
        self.assertEqual((completed / 'candidate-version').read_text(), candidate + '\n')
        self.assertEqual(json.loads((completed / 'release-metadata').read_bytes())['version'], VERSION)
        # A second confirmed completion replaces only the one sealed prior slot.
        shutil.copytree(completed, self.transaction)
        (self.transaction / 'candidate-version').write_text(candidate + '-2\n')
        self.phase.write_bytes(b'health\n')
        result = self.shell('finish_unmutated_update_transaction')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual((completed / 'candidate-version').read_text(), candidate + '-2\n')
        self.assert_unchanged()

    def test_failed_snapshot_move_restores_phase_and_retains_archive(self):
        self.newer_candidate()
        result = self.shell('finish_unmutated_update_transaction', 'rename')
        self.assertEqual(result.returncode, 1, result.stderr.decode())
        self.assert_blocked_and_retained()

    def test_death_after_phase_retirement_keeps_original_snapshot(self):
        candidate = self.newer_candidate()
        result = self.shell('finish_unmutated_update_transaction', 'death-before-rename')
        self.assertEqual(result.returncode, 77, result.stderr.decode())
        self.assertFalse(self.phase.exists())
        self.assertTrue(self.transaction.exists())
        self.assertEqual((self.transaction / 'candidate-version').read_text(), candidate + '\n')
        self.assertFalse(Path('/opt/matrix/staging/update-transaction.completed').exists())
        self.assert_unchanged()

    def test_unsealed_prior_completed_slot_cannot_be_replaced(self):
        self.newer_candidate()
        completed = Path('/opt/matrix/staging/update-transaction.completed')
        shutil.copytree(self.transaction, completed)
        os.chmod(completed, 0o775)
        result = self.shell('finish_unmutated_update_transaction')
        self.assertEqual(result.returncode, 1, result.stderr.decode())
        self.assertTrue(completed.exists())
        self.assert_blocked_and_retained()

    def test_unknown_or_unbound_phase_is_not_retirement_or_retention_authority(self):
        self.pin.unlink()
        self.phase.write_bytes(b'unknown\n')
        result = self.shell('finish_unmutated_update_transaction')
        self.assertEqual(result.returncode, 1)
        self.assertTrue(self.phase.exists())
        proof = self.shell('pending_same_version_repair_archive "$STAGING_DIR/bundle-' + VERSION + '.tar.gz"')
        self.assertEqual(proof.returncode, 1)
        self.phase.write_bytes(b'health\n')
        os.chmod(self.phase, 0o600)
        other = self.phase.with_name('arbitrary-phase-link')
        temporary = self.phase.with_name('.update-phase-retirement-restore')
        os.link(self.phase, other)
        temporary.write_bytes(b'health\n')
        for binding in ('different-inode', 'symlink', 'third-link'):
            with self.subTest(binding=binding):
                if binding != 'different-inode':
                    temporary.unlink()
                    if binding == 'symlink':
                        temporary.symlink_to(self.phase)
                    else:
                        os.link(self.phase, temporary)
                proof = self.shell('pending_same_version_repair_archive "$STAGING_DIR/bundle-' + VERSION + '.tar.gz"')
                self.assertEqual(proof.returncode, 1)
                self.assertEqual(self.phase.read_bytes(), b'health\n')
        self.assert_unchanged()

if __name__ == '__main__':
    unittest.main()

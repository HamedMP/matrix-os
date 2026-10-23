"""Real Linux file-permission regressions; executed as root in isolated temp trees."""
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'distro/customer-vps/host-bin/matrix-sync-agent-recovery'
ACTOR_UID = 65534
ACTOR_GID = 65534


class TransactionPermissionsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='matrix-transaction-permissions-')
        self.root = Path(self.directory.name)
        self.root.chmod(0o755)
        self.transaction = self.root / 'transaction'
        self.transaction.mkdir()
        (self.transaction / 'bin').mkdir()
        self.launcher = self.transaction / 'bin/matrix-gateway'
        self.launcher.write_text('#!/bin/sh\nexit 0\n')
        self.launcher.chmod(0o750)
        os.chown(self.launcher, 0, ACTOR_GID)
        (self.transaction / 'state').write_text('prepared\n')

    def tearDown(self):
        self.directory.cleanup()

    def seal(self):
        source = SOURCE.read_text()
        start = "<<'PY_TRANSACTION_PERMISSIONS'\n"
        self.assertIn(start, source, 'production transaction sealing must have a testable privileged helper')
        program = source.split(start, 1)[1].split('\nPY_TRANSACTION_PERMISSIONS', 1)[0]
        namespace = {'__name__': 'transaction_permissions_fixture'}
        exec(compile(program, str(SOURCE), 'exec'), namespace)
        namespace['seal_transaction'](str(self.transaction), ACTOR_UID, ACTOR_GID)
        return namespace

    def test_sealing_and_restoration_preserve_launcher_group_execute(self):
        source = SOURCE.read_text()
        functions = dict(re.findall(r'(?ms)^([a-z_]+)\(\) \{\n(.*?)^\}\n', source))
        script = ''
        for name in ('seal_update_transaction_permissions', 'seal_update_transaction'):
            if name in functions:
                script += name + '() {\n' + functions[name] + '}\n'
        # The account name alone is mapped to Linux's existing nobody fixture;
        # file ownership, sealing, cp -a restoration and execution are real.
        runner = self.root / 'python-runner.py'
        runner.write_text("import pwd,sys\noriginal=pwd.getpwnam\npwd.getpwnam=lambda name: original('nobody' if name=='matrix' else name)\nexec(compile(sys.stdin.read(),'<transaction-seal>','exec'))\n")
        script += '''
UPDATE_TRANSACTION_DIR="$TEST_TRANSACTION"
UPDATE_TRANSACTION_STATE="$TEST_TRANSACTION/state"
write_update_transaction_state() { printf '%s\\n' "$1" >"$UPDATE_TRANSACTION_STATE"; }
current_version() { printf 'v-test-old\\n'; }
sudo() {
  if [ "$1" = /usr/bin/test ]; then return 1; fi
  if [ "$1" = /usr/bin/timeout ]; then shift 3; fi
  if [ "$1" = /usr/bin/python3 ]; then
    shift
    [ "$1" = -I ] && [ "$2" = - ] || return 1
    shift 2
    /usr/bin/python3 -I "$TEST_PYTHON_RUNNER" "$@"
    return $?
  fi
  "$@"
}
seal_update_transaction
'''
        result = subprocess.run(['bash', '-euc', script], env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'TEST_TRANSACTION': str(self.transaction), 'TEST_PYTHON_RUNNER': str(runner)}, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        restored = self.root / 'restored-launcher'
        subprocess.run(['cp', '-a', str(self.launcher), str(restored)], check=True, timeout=5)
        self.assertEqual(restored.stat().st_gid, ACTOR_GID)
        self.assertEqual(stat.S_IMODE(restored.stat().st_mode), 0o750)
        execution = subprocess.run(['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '--no-new-privs', '--', str(restored)], capture_output=True, timeout=5)
        self.assertEqual(execution.returncode, 0, execution.stderr)

    def test_preserves_bin_group_but_seals_control_files_and_directories(self):
        control = self.transaction / 'candidate-version'
        control.write_text('v-test\n')
        os.chown(control, ACTOR_UID, ACTOR_GID)
        os.chown(self.transaction, ACTOR_UID, ACTOR_GID)
        self.seal()
        self.assertEqual((self.transaction.stat().st_uid, self.transaction.stat().st_gid), (0, 0))
        self.assertEqual((control.stat().st_uid, control.stat().st_gid), (0, 0))
        self.assertEqual((self.launcher.stat().st_uid, self.launcher.stat().st_gid), (0, ACTOR_GID))
        self.assertEqual(stat.S_IMODE(self.launcher.stat().st_mode), 0o750)

    def test_keeps_root_only_payload_private(self):
        self.launcher.chmod(0o700)
        os.chown(self.launcher, 0, 0)
        self.seal()
        self.assertEqual((self.launcher.stat().st_gid, stat.S_IMODE(self.launcher.stat().st_mode)), (0, 0o700))

    def test_rejects_symbolic_links_without_touching_the_target(self):
        outside = self.root / 'outside'
        outside.write_text('keep')
        outside.chmod(0o640)
        (self.transaction / 'bin/linked').symlink_to(outside)
        with self.assertRaises((ValueError, OSError)):
            self.seal()
        self.assertEqual(outside.read_text(), 'keep')
        self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o640)

    def test_rejects_hardlinked_payloads(self):
        os.link(self.launcher, self.transaction / 'bin/alias')
        with self.assertRaises(ValueError):
            self.seal()

    def test_rejects_special_files_without_blocking(self):
        os.mkfifo(self.transaction / 'bin/pipe')
        with self.assertRaises((ValueError, OSError)):
            self.seal()

    def test_rejects_writable_privileged_payloads(self):
        self.launcher.chmod(0o770)
        with self.assertRaises(ValueError):
            self.seal()

    def test_bounds_snapshot_entries(self):
        source = SOURCE.read_text()
        marker = "<<'PY_TRANSACTION_PERMISSIONS'\n"
        self.assertIn(marker, source)
        namespace = {'__name__': 'transaction_permissions_fixture'}
        exec(compile(source.split(marker, 1)[1].split('\nPY_TRANSACTION_PERMISSIONS', 1)[0], str(SOURCE), 'exec'), namespace)
        namespace['MAX_ENTRIES'] = 1
        with self.assertRaises(ValueError):
            namespace['seal_transaction'](str(self.transaction), ACTOR_UID, ACTOR_GID)


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('Run this isolated Linux fixture as root; no host services or accounts are changed.')
    unittest.main()

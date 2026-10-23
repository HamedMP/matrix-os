"""Exercise generated first-upgrade bootstrap with actual predecessor install/commit."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
VERSION, SHA = 'v-browser-first-upgrade', 'a' * 40


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stage = self.root / 'stage'
        for part in ('bin', 'systemd'):
            (self.stage / part).mkdir(parents=True)
        self.helper = b'# native reviewed helper\n'
        self.runtime = b'bounded runtime fixture'
        (self.stage / 'bin/matrix-browser-runtime.py').write_bytes(self.helper)
        (self.stage / 'bin/matrix-browser-runtime.tar.gz').write_bytes(self.runtime)
        (self.stage / 'bin/matrix-browser-runtime.tar.gz.sha256').write_text(hashlib.sha256(self.runtime).hexdigest() + '\n')
        (self.stage / 'systemd/matrix-browser-runtime.service').write_text('[Service]\nExecStart=/usr/bin/python3 -I /usr/local/libexec/matrix-browser-runtime.py\n')
        (self.stage / 'release.json').write_text(json.dumps({'version': VERSION, 'gitCommit': SHA}))
        (self.stage / 'bin/matrix-sync-agent').write_bytes((ROOT / 'distro/customer-vps/host-bin/matrix-sync-agent').read_bytes())
        subprocess.run(['node', str(ROOT / 'scripts/prepare-browser-host-bootstrap.mjs'), str(self.stage)], check=True, capture_output=True)
        self.agent = (self.stage / 'bin/matrix-sync-agent').read_text()
        self.inline = re.search(r"<<'MATRIX_BROWSER_VERIFIED_BOOTSTRAP'\n([\s\S]*?)\nMATRIX_BROWSER_VERIFIED_BOOTSTRAP", self.agent).group(1)
        self.ns = {'__name__': 'fixture'}
        exec(compile(self.inline, '<generated-browser-bootstrap>', 'exec'), self.ns)
        self.host = self.root / 'host'
        self.host.mkdir()
        for part in ('opt/matrix/app', 'opt/matrix/bin', 'opt/matrix/env', 'etc/systemd/system', 'usr/local/libexec'):
            (self.host / part).mkdir(parents=True)
        self.environment = ('MATRIX_BROWSER_LAB=true\nMATRIX_RUNTIME_SLOT=primary\nMATRIX_HANDLE=test-customer\n'
                            'MATRIX_CLERK_USER_ID=user_fixture\nMATRIX_MACHINE_ID=12345678-1234-4234-9234-123456789012\n')
        (self.host / 'opt/matrix/env/host.env').write_text(self.environment)
        (self.host / 'opt/matrix/app/BUNDLE_VERSION').write_text(VERSION + '\n')
        self.calls = []

    def old_install_and_commit(self):
        # Execute the real predecessor installation function, not the new updater.
        old = (ROOT / 'tests/deploy/customer-vps/fixtures/browser-predecessor-updater.sh').read_text()
        self.assertEqual(hashlib.sha256(old.encode()).hexdigest(), '788077a6942c900732c4e8f73ffd4d1a4261d333248c8725fe3c6a8958a839d6')
        install = re.search(r'install_host_bin_payload\(\) \{[\s\S]*?\n\}', old).group(0)
        commit = re.search(r'commit_release_metadata\(\) \{[\s\S]*?\n\}', old).group(0)
        restart = re.search(r'restart_sync_agent_after_update\(\) \{[\s\S]*?\n\}', old).group(0)
        shell = """set -eu
log() { :; }
sudo() {
 local args=()
 while [ "$#" -gt 0 ]; do
  case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
 done
 if [ "${args[0]}" = systemctl ]; then echo restarted > "$HOST/restarted"; return; fi
 "${args[@]}"
}
BIN_DIR="$HOST/opt/matrix/bin"
RELEASE_FILE="$HOST/opt/matrix/release.json"
RELEASE_ROLLBACK_FILE="$HOST/opt/matrix/release.json.rollback"
staged_release_metadata="$STAGE/release.json"
""" + install + '\n' + commit + '\n' + restart + """
install_host_bin_payload "$STAGE/bin"
cp "$STAGE/systemd/matrix-browser-runtime.service" "$HOST/etc/systemd/system/"
commit_release_metadata
restart_sync_agent_after_update
"""
        result = subprocess.run(['bash', '-c', shell], env={**os.environ, 'HOST': str(self.host), 'STAGE': str(self.stage)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.host / 'restarted').exists())
        self.assertFalse((self.host / 'usr/local/libexec/matrix-browser-runtime.py').exists())

    def invoke(self):
        with patch.object(self.ns['subprocess'], 'run', side_effect=lambda command, **kwargs: self.calls.append(command)):
            return self.ns['reconcile'](self.host, os.getuid())

    def startup(self, healthy=True):
        # Run the generated shell entry from actual startup after recovery. Only
        # platform commands and the fixture root are adapted; bootstrap is exact.
        function = re.search(r'# BEGIN inlined Browser host bootstrap[\s\S]*?# END inlined Browser host bootstrap', self.agent).group(0)
        start = self.agent.index('\nrecover_interrupted_update\n')
        end = self.agent.index('\nreconcile_postgres_root_service || log', start)
        startup = self.agent[start:end]
        adapter = """import os,sys
from pathlib import Path
namespace = {'__name__': 'fixture'}
exec(compile(sys.stdin.read(), '<actual-generated-bootstrap>', 'exec'), namespace)
namespace['subprocess'].run = lambda command, **kwargs: print('NATIVE ' + ' '.join(command))
namespace['reconcile'](Path(os.environ['HOST']), os.getuid())
"""
        shell = """set -eu
UPDATE_PHASE_MARKER="$HOST/opt/matrix/staging/update-phase"
APP_DIR="$HOST/opt/matrix/app"
current_version() { cat "$APP_DIR/BUNDLE_VERSION"; }
running_gateway_version() { [ "$HEALTHY" = true ] && current_version; }
recover_interrupted_update() { echo recovered; }
funded_host_bootstrap() { :; }
log() { printf '%s\\n' "$*"; }
sudo() { python3 -I -c """ + shlex.quote(adapter) + "; }\n" + function + startup
        return subprocess.run(['bash', '-c', shell], text=True, capture_output=True,
                              env={**os.environ, 'HOST': str(self.host), 'HEALTHY': str(healthy).lower()})

    def test_first_old_updater_upgrade_then_new_startup_installs_once(self):
        self.old_install_and_commit()
        startup = self.startup()
        self.assertEqual(startup.returncode, 0, startup.stderr)
        self.assertIn('recovered', startup.stdout)
        self.assertIn('NATIVE /usr/bin/systemctl start --no-block matrix-browser-runtime.service', startup.stdout)
        self.assertEqual((self.host / 'usr/local/libexec/matrix-browser-runtime.py').read_bytes(), self.helper)
        again = self.startup()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertNotIn('NATIVE ', again.stdout)
        self.assertIn('reconcile_browser_host_bootstrap || log', self.agent)
        startup = self.agent[self.agent.index('# ── Main loop'):]
        self.assertLess(startup.index('recover_interrupted_update'), startup.index('reconcile_browser_host_bootstrap'))

    def test_unhealthy_new_startup_defers_without_affecting_core(self):
        self.old_install_and_commit()
        startup = self.startup(healthy=False)
        self.assertEqual(startup.returncode, 0, startup.stderr)
        self.assertIn('Browser first-upgrade bootstrap deferred', startup.stdout)
        self.assertNotIn('NATIVE ', startup.stdout)
        self.assertFalse((self.host / 'usr/local/libexec/matrix-browser-runtime.py').exists())

    def test_modified_helper_is_rejected_before_protected_copy(self):
        self.old_install_and_commit()
        (self.host / 'opt/matrix/bin/matrix-browser-runtime.py').write_text('malicious')
        with self.assertRaises((ValueError, OSError)): self.invoke()
        self.assertFalse((self.host / 'usr/local/libexec/matrix-browser-runtime.py').exists())
        self.assertEqual(self.calls, [])

    def test_release_provenance_mismatch_is_rejected(self):
        self.old_install_and_commit()
        (self.host / 'opt/matrix/release.json').write_text(json.dumps({'version': VERSION, 'gitCommit': 'b' * 40}))
        with self.assertRaises((ValueError, OSError)): self.invoke()
        self.assertEqual(self.calls, [])

    def test_opt_out_or_uncommitted_update_never_schedules(self):
        self.old_install_and_commit()
        (self.host / 'opt/matrix/env/host.env').write_text(self.environment.replace('MATRIX_BROWSER_LAB=true', 'MATRIX_BROWSER_LAB=false'))
        self.invoke()
        self.assertEqual(self.calls, [])
        (self.host / 'opt/matrix/env/host.env').write_text(self.environment)
        (self.host / 'opt/matrix/staging').mkdir()
        (self.host / 'opt/matrix/staging/update-phase').write_text('health')
        self.invoke()
        self.assertEqual(self.calls, [])
        (self.host / 'opt/matrix/staging/update-phase').unlink()
        (self.host / 'opt/matrix/app/.rollback-now').write_text('')
        self.invoke()
        self.assertEqual(self.calls, [])

    def test_symlink_and_writable_ancestors_fail_closed(self):
        self.old_install_and_commit()
        target = self.host / 'usr/local/libexec'
        target.rmdir()
        target.symlink_to(self.stage, target_is_directory=True)
        with self.assertRaises((ValueError, OSError)): self.invoke()
        self.assertEqual(self.calls, [])

    def test_invalid_customer_identity_and_optout_do_not_mutate_os_containers(self):
        self.old_install_and_commit()
        environment = self.host / 'opt/matrix/env/host.env'
        for relative in ('opt/matrix', 'opt/matrix/env', 'opt/matrix/bin'):
            (self.host / relative).chmod(0o770)
        for text in (self.environment.replace('MATRIX_RUNTIME_SLOT=primary', 'MATRIX_RUNTIME_SLOT=preview'),
                     self.environment.replace('MATRIX_HANDLE=test-customer', 'MATRIX_HANDLE=pv-123'),
                     self.environment + 'MATRIX_USER_ID=user_foreign\n',
                     self.environment.replace('MATRIX_CLERK_USER_ID=user_fixture\n', ''),
                     self.environment.replace('MATRIX_BROWSER_LAB=true', 'MATRIX_BROWSER_LAB=false')):
            environment.write_text(text)
            try:
                self.invoke()
            except ValueError:
                pass
            for relative in ('opt/matrix', 'opt/matrix/env', 'opt/matrix/bin'):
                self.assertEqual((self.host / relative).stat().st_mode & 0o777, 0o770)
            self.assertFalse((self.host / 'var/lib/matrix-browser-bootstrap').exists())
            self.assertFalse((self.host / 'usr/local/libexec/matrix-browser-runtime.py').exists())
            self.assertEqual(self.calls, [])

    def test_primary_owner_identity_is_required_even_after_successful_receipt(self):
        self.old_install_and_commit()
        self.invoke()
        self.calls.clear()
        for original, changed in (('MATRIX_RUNTIME_SLOT=primary', 'MATRIX_RUNTIME_SLOT=preview'),
                                  ('MATRIX_HANDLE=test-customer', 'MATRIX_HANDLE=pv-123'),
                                  ('MATRIX_CLERK_USER_ID=user_fixture', 'MATRIX_CLERK_USER_ID=invalid'),
                                  ('MATRIX_MACHINE_ID=12345678-1234-4234-9234-123456789012', 'MATRIX_MACHINE_ID=invalid')):
            (self.host / 'opt/matrix/env/host.env').write_text(self.environment.replace(original, changed))
            with self.assertRaises((ValueError, OSError)): self.invoke()
            self.assertEqual(self.calls, [])

    def test_modified_payload_unit_or_writable_os_ancestor_is_rejected(self):
        self.old_install_and_commit()
        for relative in ('opt/matrix/bin/matrix-browser-runtime.tar.gz', 'etc/systemd/system/matrix-browser-runtime.service'):
            target = self.host / relative
            original = target.read_bytes()
            target.write_bytes(b'changed')
            with self.assertRaises((ValueError, OSError)): self.invoke()
            self.assertEqual(self.calls, [])
            target.write_bytes(original)
        (self.host / 'usr/local').chmod(0o777)
        with self.assertRaises((ValueError, OSError)): self.invoke()
        self.assertEqual(self.calls, [])

    def test_historical_group_writable_os_containers_are_hardened_nonrecursively(self):
        self.old_install_and_commit()
        for relative in ('opt/matrix', 'opt/matrix/bin', 'opt/matrix/env'):
            (self.host / relative).chmod(0o770)
        owner_data = self.host / 'opt/matrix/app'
        owner_data.chmod(0o775)
        self.invoke()
        self.assertEqual(owner_data.stat().st_mode & 0o777, 0o775)
        for relative in ('opt/matrix', 'opt/matrix/bin', 'opt/matrix/env'):
            self.assertEqual((self.host / relative).stat().st_mode & 0o022, 0)

    def test_protected_destination_symlink_or_app_version_mismatch_is_rejected(self):
        self.old_install_and_commit()
        version = self.host / 'opt/matrix/app/BUNDLE_VERSION'
        version.write_text('v-other')
        with self.assertRaises((ValueError, OSError)): self.invoke()
        version.write_text(VERSION)
        (self.host / 'usr/local/libexec/matrix-browser-runtime.py').symlink_to(self.stage / 'bin/matrix-browser-runtime.py')
        with self.assertRaises((ValueError, OSError)): self.invoke()
        self.assertEqual(self.calls, [])

    def test_failed_scheduling_retains_no_receipt_and_retry_succeeds(self):
        self.old_install_and_commit()
        with patch.object(self.ns['subprocess'], 'run', side_effect=subprocess.CalledProcessError(1, 'systemctl')):
            with self.assertRaises(subprocess.CalledProcessError):
                self.ns['reconcile'](self.host, os.getuid())
        self.assertFalse((self.host / 'var/lib/matrix-browser-bootstrap/receipt.json').exists())
        self.invoke()
        self.assertTrue((self.host / 'var/lib/matrix-browser-bootstrap/receipt.json').exists())
        self.assertIn(['/usr/bin/systemctl', 'start', '--no-block', 'matrix-browser-runtime.service'], self.calls)
        self.assertFalse(any('reset-failed' in command for command in self.calls))

    def test_legacy_payload_absence_is_noop(self):
        self.old_install_and_commit()
        (self.host / 'opt/matrix/bin/matrix-browser-runtime.tar.gz').unlink()
        self.invoke()
        self.assertEqual(self.calls, [])


if __name__ == '__main__': unittest.main()

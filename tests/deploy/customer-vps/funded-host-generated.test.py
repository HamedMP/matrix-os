"""Generated protected program integration in disposable root Linux.

Network/DNS and systemctl are mocks. Archive hashing, protected installation,
program entry, environment writes, journals and rollback use real root paths.
Run only in disposable network-disabled container, never on an actual host.
"""
import grp
import fcntl
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[3]
SHA = 'a' * 40
A, B = 'v-test-generated-a', 'v-test-generated-b'
IDENTITY = {'handle': 'test-main', 'machineId': '12345678-1234-4234-9234-123456789012',
            'runtimeSlot': 'primary', 'runtimeTokenEpoch': 2}
SERVICES = ('matrix-gateway.service', 'matrix-shell.service', 'matrix-terminal-runtime.service',
            'matrix-scope-runtime.service', 'matrix-symphony.service', 'matrix-sync-agent.service')


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').is_dir(), 'disposable root Linux only')
class GeneratedProgramTests(unittest.TestCase):
    def test_generated_bootstrap_and_program_two_hop_apply_noop_rollback(self):
        # Fail closed outside an explicitly disposable harness.
        self.assertEqual(os.environ.get('MATRIX_DISPOSABLE_ROOT_TEST'), 'true')
        self.assertTrue(Path('/.dockerenv').exists())
        self.assertFalse(Path('/opt/matrix').exists())
        self.assertFalse(Path('/var/lib/matrix-funded-host-config').exists())
        self.assertFalse(Path('/usr/local/libexec/matrix-funded-host-config.py').exists())
        self.assertFalse(Path('/etc/systemd/system/matrix-funded-host-config.service').exists())
        def cleanup_fixture():
            for root in ('/opt/matrix', '/var/lib/matrix-funded-host-config'):
                if Path(root).exists():
                    shutil.rmtree(root)
            for file in ('/usr/local/libexec/matrix-funded-host-config.py', '/etc/systemd/system/matrix-funded-host-config.service'):
                Path(file).unlink(missing_ok=True)
        self.addCleanup(cleanup_fixture)
        try:
            gid = grp.getgrnam('matrix').gr_gid
        except KeyError:
            subprocess.run(['/usr/sbin/groupadd', 'matrix'], check=True)
            gid = grp.getgrnam('matrix').gr_gid
        subprocess.run(['/usr/sbin/useradd', '-M', '-g', 'matrix', 'matrix'], check=True)
        for name, mode in [('opt/matrix', 0o770), ('opt/matrix/env', 0o750),
                           ('opt/matrix/staging', 0o755), ('opt/matrix/app', 0o755)]:
            path = Path('/') / name
            path.mkdir(parents=True, exist_ok=True)
            os.chown(path, 0, gid)
            os.chmod(path, mode)
        original = ('# preserved owner config\nMATRIX_MACHINE_ID=' + IDENTITY['machineId'] +
                    '\nMATRIX_CLERK_USER_ID=user_test\nMATRIX_HANDLE=test-main\nMATRIX_RUNTIME_SLOT=primary\n'
                    'MATRIX_RUNTIME_TOKEN_EPOCH=2\nMATRIX_SYNC_RUNTIME_TOKEN=' + 'd' * 64 +
                    '\nPLATFORM_INTERNAL_URL=https://app.matrix-os.com\nUNRELATED="literal $value"\n').encode()
        env = Path('/opt/matrix/env/host.env')
        env.write_bytes(original)
        os.chown(env, 0, gid)
        os.chmod(env, 0o640)
        with tempfile.TemporaryDirectory() as temporary:
            agent = Path(temporary) / 'agent'
            agent.write_bytes((ROOT / 'distro/customer-vps/host-bin/matrix-sync-agent').read_bytes())
            component = Path(temporary) / 'component'
            subprocess.run(['node', str(ROOT / 'scripts/prepare-funded-host-component.mjs'), str(agent), str(component)], check=True)
            subprocess.run(['node', str(ROOT / 'scripts/inline-sync-agent-recovery.mjs'), str(agent), *[str(ROOT / ('distro/customer-vps/host-bin/' + name)) for name in ('matrix-sync-agent-recovery', 'matrix-update-manifest', 'matrix-update-request-rejection')]], check=True)
            built = agent.read_text()
            inline = re.search(r"<<'MATRIX_FUNDED_VERIFIED_BOOTSTRAP'\n([\s\S]*?)\nMATRIX_FUNDED_VERIFIED_BOOTSTRAP", built).group(1)
            # Use the exact emitted inline Python, not a rewritten implementation.
            code = (component / 'reconcile.py').read_bytes()
            unit = (component / 'matrix-funded-host-config.service').read_bytes()
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                directory = tarfile.TarInfo('funded-host-config/')
                directory.type = tarfile.DIRTYPE
                archive.addfile(directory)
                for name, data in [('funded-host-config/reconcile.py', code),
                                   ('funded-host-config/matrix-funded-host-config.service', unit),
                                   ('app/BUNDLE_VERSION', (B + '\n').encode())]:
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
                # A mutable extraction is deliberately irrelevant to root install.
                info = tarfile.TarInfo('app/link')
                info.type, info.linkname = tarfile.SYMTYPE, '/tmp/irrelevant'
                archive.addfile(info)
            archive_bytes = stream.getvalue()
        malicious = Path('/opt/matrix/staging/extracted/funded-host-config')
        malicious.mkdir(parents=True)
        (malicious / 'reconcile.py').write_text("open('/tmp/funded-attacker-executed', 'w').write('bad')")
        states = {name: 'active' for name in SERVICES}
        states['matrix-symphony.service'] = 'inactive'
        calls, requests, fail_after_journal = [], [], False
        delayed_start, delayed_stop, failed_resume, restore_clock, pending = False, False, False, [0], {}
        pending_stops = {}
        unsafe_environment = False
        version = A
        def metadata(selected):
            query = urlencode({'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
                'X-Amz-Credential': 'testkey/20261009/auto/s3/aws4_request', 'X-Amz-Date': '20261009T000000Z',
                'X-Amz-Expires': '300', 'X-Amz-SignedHeaders': 'host', 'X-Amz-Signature': 'a' * 64})
            return {'version': selected, 'gitCommit': SHA, 'size': len(archive_bytes),
                'sha256': hashlib.sha256(archive_bytes).hexdigest(), 'url': 'https://bundles.' + 'a' * 32 +
                '.eu.r2.cloudflarestorage.com/system-bundles/' + selected + '/matrix-host-bundle.tar.gz?' + query}
        def request(client, method, path, body=None, headers=None, **kwargs):
            requests.append((client.host, path.split('?')[0], dict(headers or {})))
            if path.startswith('/system-bundles/releases/'):
                selected = path.rsplit('/', 1)[1].removesuffix('.json')
                data = json.dumps(metadata(selected)).encode()
            elif client.host.endswith('.r2.cloudflarestorage.com'):
                self.assertNotIn('Authorization', headers)
                data = archive_bytes
            else:
                self.assertEqual(headers['Authorization'], 'Bearer ' + 'd' * 64)
                import datetime
                stamp = lambda value: datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                data = json.dumps({'contractVersion': 1, 'kind': 'matrix-funded-host-config', 'source': 'platform',
                    'sourceSha': SHA, 'issuedAt': stamp(time.time() - .1), 'expiresAt': stamp(time.time() + 20),
                    'identity': IDENTITY, 'configuration': {'MATRIX_FUNDED_AI_ENABLED': 'true',
                    'MATRIX_FUNDED_AI_RELAY_URL': 'https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app',
                    'MATRIX_FUNDED_AI_RUNTIME_TOKEN': 'c' * 64, 'MATRIX_FUNDED_AI_PLATFORM_URL': 'https://app.matrix-os.com'}}).encode()
            client.mock_response = type('Response', (), {'status': 200, 'read': io.BytesIO(data).read})()
        real_run = subprocess.run
        def systemctl(args, **kwargs):
            nonlocal fail_after_journal
            if args[0] != '/usr/bin/systemctl':
                return real_run(args, **kwargs)
            calls.append(tuple(args[1:]))
            self.assertEqual(kwargs['timeout'], 10)
            action, service = args[1], args[-1]
            applied_path = Path('/var/lib/matrix-funded-host-config/applied.json')
            if unsafe_environment and action == 'is-active' and service == 'matrix-gateway.service' \
                    and calls[-2][0] == 'show' and applied_path.exists() \
                    and 'afterSha256' in json.loads(applied_path.read_bytes()):
                raise RuntimeError('synthetic post-write inspection unavailable')
            if fail_after_journal and action == 'is-active' and service == 'matrix-gateway.service' \
                    and list(env.parent.glob('host.env.funded-*.json')):
                fail_after_journal = False
                raise RuntimeError('synthetic late post-journal guard rejection')
            output = ''
            if action == 'show': output = 'loaded' if 'LoadState' in args[2] else 'control-group'
            elif action == 'is-active':
                if failed_resume and service == 'matrix-gateway.service':
                    output = 'failed'
                else:
                    if service in pending_stops and restore_clock[0] >= pending_stops[service]:
                        states[service] = 'inactive'
                        del pending_stops[service]
                    if service in pending and restore_clock[0] >= pending[service]:
                        states[service] = 'active'
                    output = states[service]
            elif action in ('stop', 'start') and service in states:
                if action == 'start' or delayed_stop:
                    self.assertIn('--no-block', args)
                if action == 'start':
                    self.assertNotEqual(states[service], 'deactivating')
                    if service == 'matrix-sync-agent.service':
                        expected = 'inactive' if unsafe_environment else 'active'
                        self.assertTrue(all(states[s] == expected for s in SERVICES[:-1] if s != 'matrix-symphony.service'))
                states[service] = ('deactivating' if delayed_stop else 'inactive') if action == 'stop' else ('activating' if delayed_start else 'active')
                if action == 'stop' and delayed_stop:
                    pending_stops[service] = restore_clock[0] + (45 if service == 'matrix-scope-runtime.service' else 30)
                if action == 'start' and delayed_start:
                    pending[service] = restore_clock[0] + (1440 if service == 'matrix-gateway.service' else 15)
            return subprocess.CompletedProcess(args, 0, output.encode(), b'')
        def bootstrap(operation, selected, prior=''):
            if operation == 'retry':
                trigger = Path('/opt/matrix/app/.update-now')
                trigger.write_text('explicit')
                Path('/opt/matrix/app/.update-version').write_text(selected)
                branch = built[built.index('  if [ -f "$UPDATE_TRIGGER" ]; then'):built.index('  if [ -f "$ROLLBACK_TRIGGER" ]; then')]
                shell = recovery_shell() + '\n' + built.split('# BEGIN inlined update request rejection library\n', 1)[1].split('# END inlined update request rejection library', 1)[0]
                shell += '''
UPDATE_TRIGGER=/opt/matrix/app/.update-now
UPDATE_MARKER=/opt/matrix/app/.update-available.json
UPDATE_VERSION_FILE=/opt/matrix/app/.update-version
UPDATE_CHANNEL_FILE=/opt/matrix/app/.update-channel
AUTO_APPLY_FAILED_MARKER=/opt/matrix/app/.auto-apply-failed
consume_update_trigger() { rm -f "$UPDATE_TRIGGER"; }
prepare_triggered_update() { prepare_triggered_update_action=already-current; }
funded_host_bootstrap() { [ ! -e "$UPDATE_TRIGGER" ] || return 1; echo "protected:$1:$2"; }
''' + ('\nprepare_triggered_update() { prepare_triggered_update_action=already-current; echo raced > "$UPDATE_VERSION_FILE"; }\n' if prior == 'raced' else '') + branch
                result = real_run(['bash', '-c', shell], capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                if prior == 'raced':
                    self.assertTrue(trigger.exists())
                    self.assertNotIn(b'protected:', result.stdout)
                    self.assertEqual(Path('/opt/matrix/app/.update-version').read_text(), 'raced\n')
                    trigger.unlink()
                    return
                self.assertFalse(trigger.exists())
                self.assertIn(('protected:retry:' + selected).encode(), result.stdout)
                # A later trigger-only apply must prefer the pending newer marker,
                # rather than the consumed same-version target left on disk.
                prepare = re.search(r'prepare_triggered_update\(\) \{[\s\S]*?\n\}', built).group(0)
                Path('/opt/matrix/app/.update-available.json').write_text(json.dumps({'version': 'v-newer', 'channel': 'stable'}))
                trigger.write_text('next-explicit')
                followup = shell[:shell.index('consume_update_trigger()')] + prepare + '''
json_field() { python3 -c "import json,sys;print(json.load(sys.stdin).get(sys.argv[1],''))" "$2" <<< "$1"; }
release_url_for_version() { echo "$1"; }
fetch_manifest() { echo '{"version":"''' + selected + '''"}'; }
installed_terminal_runtime_is_ready() { return 0; }
prepare_triggered_update || exit 1
[ "$prepare_triggered_update_action" = apply ] || exit 2
'''
                checked = real_run(['bash', '-c', followup], capture_output=True, timeout=10)
                self.assertEqual(checked.returncode, 0, checked.stderr.decode())
                trigger.unlink()
                Path('/opt/matrix/app/.update-available.json').unlink()
            with patch.object(sys, 'argv', ['-', operation, selected, prior]):
                try:
                    exec(compile(inline, '<actual-generated-inline-bootstrap>', 'exec'), {'__name__': '__main__'})
                except SystemExit as error:
                    if error.code != 0:
                        raise
        def installed(action):
            with patch.object(sys, 'argv', ['/usr/local/libexec/matrix-funded-host-config.py', action]):
                runpy.run_path('/usr/local/libexec/matrix-funded-host-config.py', run_name='__main__')
        def current(selected):
            Path('/opt/matrix/release.json').write_text(json.dumps({'version': selected, 'gitCommit': SHA}))
            os.chown('/opt/matrix/release.json', 0, gid)
            os.chmod('/opt/matrix/release.json', 0o644)
            Path('/opt/matrix/app/BUNDLE_VERSION').write_text(selected + '\n')
        def recovery_shell():
            function = re.search(r'funded_host_bootstrap\(\) \{[\s\S]*?\n\}', built).group(0)
            preserve = re.search(r'preserve_host_rollback_transaction\(\) \{[\s\S]*?\n\}', built).group(0)
            shell = function + '\n' + preserve + '\n' + built.split('# BEGIN inlined update recovery library\n', 1)[1].split('# END inlined update recovery library', 1)[0]
            return shell + r'''
APP_DIR=/opt/matrix/app
STAGING_DIR=/opt/matrix/staging
RELEASE_FILE=/opt/matrix/release.json
UPDATE_TRANSACTION_DIR=$STAGING_DIR/update-transaction
UPDATE_TRANSACTION_STATE=$UPDATE_TRANSACTION_DIR/state
UPDATE_PHASE_MARKER=$STAGING_DIR/update-phase
TERMINAL_RUNTIME_GENERATION_FILE=TERMINAL_RUNTIME_GENERATION
HEALTH_URL=http://unused
sudo() { if [ "$1" = systemctl ] || [ "$1" = chown ]; then return 0; fi; command "$@"; }
log() { echo "$*" >&2; }
stop_runtime_services() { echo stopped; }
restore_update_transaction() { cp -a "$UPDATE_TRANSACTION_DIR/release-metadata" "$RELEASE_FILE"; }
resume_update_transaction_services() { echo resumed; }
cleanup_terminal_runtime_generations() { :; }
resume_symphony_after_update() { :; }
restore_retired_symphony_after_rollback() { :; }
clear_retired_symphony_rollback_after_rollback() { :; }
cleanup_update_transaction() { rm -rf "$UPDATE_TRANSACTION_DIR" "$STAGING_DIR/update-phase"; }
current_version() { cat "$APP_DIR/BUNDLE_VERSION"; }
curl() { return 0; }
date() { if [ "$1" = +%s ]; then echo 1; else command date "$@"; fi; }
transaction_candidate_is_committed() { return 1; }
clear_consumed_update_markers() { :; }
write_update_error() { echo "error:$1"; }
'''
        def failed_candidate_recovery(selected, swapped=True, manual=False, mutate=None,
                                      interrupted=False, restore_failure=False, preflight=False,
                                      changed_after_restore=False, move_failure=False):
            transaction = Path('/opt/matrix/staging/update-transaction')
            transaction.mkdir(exist_ok=True)
            for name, data in [('state', 'mutating\n'), ('candidate-version', selected + '\n'),
                               ('release-metadata', Path('/opt/matrix/release.json').read_text())]:
                (transaction / name).write_text(data)
                os.chmod(transaction / name, 0o644)
            os.chmod(transaction, 0o755)
            Path('/opt/matrix/staging/update-phase').write_text('health\n')
            os.chmod('/opt/matrix/staging/update-phase', 0o600)
            if swapped:
                Path('/opt/matrix/app').rename('/opt/matrix/app.rollback')
                Path('/opt/matrix/app').mkdir()
                Path('/opt/matrix/app/BUNDLE_VERSION').write_text(selected + '\n')
            if mutate:
                mutate(transaction)
            # Exact emitted bootstrap and real rollback moves; unrelated
            # transaction artifacts, systemd and health are mocks.
            shell = recovery_shell()
            if restore_failure:
                shell += '\nrestore_update_transaction() { return 1; }\n'
            if changed_after_restore:
                shell += "\nrestore_update_transaction() { printf '# changed\\n' >> /opt/matrix/env/host.env; }\n"
            if move_failure:
                shell += '\nsudo() { if [ "$1" = mv ]; then return 1; fi; if [ "$1" = systemctl ] || [ "$1" = chown ]; then return 0; fi; command "$@"; }\n'
            if preflight:
                shell += '\nfunded_host_bootstrap recovery-preflight\n'
            elif interrupted:
                shell += '\nrecover_interrupted_update\n'
            else:
                shell += '\ndo_rollback ' + ('true' if manual else 'false') + '\n'
            return real_run(['bash', '-c', shell], capture_output=True, timeout=20)
        def failed_update(failure, same_version=False, rollback_fault=None, success=False):
            candidate = B if same_version else 'v-test-candidate-c'
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                data = (candidate + '\n').encode()
                info = tarfile.TarInfo('app/BUNDLE_VERSION')
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            with tempfile.NamedTemporaryFile() as bundle:
                data = archive_bytes if same_version else stream.getvalue()
                bundle.write(data)
                bundle.flush()
                manifest = {'version': candidate, 'sha256': hashlib.sha256(data).hexdigest(),
                            'url': 'https://unused', 'size': len(data)}
                Path('/opt/matrix/app/.update-available.json').write_text(json.dumps(manifest))
                apply = built[built.index('apply_update() {'):built.index('\nrun_apply_update()')]
                cleanup = re.search(r'cleanup_update_transaction\(\) \{[\s\S]*?\n\}', built).group(0)
                shell = recovery_shell() + '\n' + cleanup + '\n' + apply + r'''
UPDATE_MARKER=$APP_DIR/.update-available.json
UPDATE_ERROR_MARKER=$APP_DIR/.update-error.json
VERSION_FILE=$APP_DIR/BUNDLE_VERSION
update_request_identity() { echo fingerprint; }
load_trusted_apply_manifest() { cat "$UPDATE_MARKER"; }
json_field() { python3 -c 'import json,sys;print(json.load(sys.stdin).get(sys.argv[1],""))' "$2" <<< "$1"; }
compare_host_bundle_versions() { echo newer; }
ensure_update_headroom() { :; }
consume_update_trigger() { :; }
write_update_phase() { printf '%s\n' "$1" > "$UPDATE_PHASE_MARKER"; chmod 600 "$UPDATE_PHASE_MARKER"; }
download_bundle() { cp "$FIXTURE_BUNDLE" "$5"; }
prepare_legacy_r2_migration() { :; }
stage_release_metadata() { :; }
cleanup_staged_release_metadata() { :; }
prepare_update_transaction() {
 mkdir -p "$UPDATE_TRANSACTION_DIR"
 printf '%s\n' "$2" > "$UPDATE_TRANSACTION_DIR/candidate-version"
 cp "$RELEASE_FILE" "$UPDATE_TRANSACTION_DIR/release-metadata"
 printf 'prepared\n' > "$UPDATE_TRANSACTION_STATE"
 chmod 755 "$UPDATE_TRANSACTION_DIR"; chmod 644 "$UPDATE_TRANSACTION_DIR"/*
}
seal_update_transaction() { :; }
install_terminal_runtime_bootstrap_helpers() { [ "$FAILURE" != terminal-helper ]; }
install_terminal_runtime_payload() { :; }
sudo() {
 if [ "$1" = systemctl ]; then
   if [ "$FAILURE" = terminal-start ] && [ "$2" = start ] && [ "$3" = matrix-terminal-runtime ] \
     && [ "$(current_version)" = v-test-candidate-c ]; then return 1; fi
   return 0
 fi
 if [ "$1" = chown ]; then return 0; fi
 command "$@"
}
running_gateway_version() { return 1; }
sleep() { :; }
if apply_update explicit; then exit 2; fi
'''
                functions = '\n'.join(re.search(name + r'\(\) \{[\s\S]*?\n\}', built).group(0)
                                      for name in ('write_update_transaction_state', 'seal_update_transaction'))
                shell = shell.replace('seal_update_transaction() { :; }', functions)
                if failure == 'preflight':
                    shell = shell.replace('if apply_update explicit; then exit 2; fi',
                        'funded_host_bootstrap() { return 1; }\nif apply_update explicit; then exit 2; fi')
                if success:
                    preserve = re.search(r'preserve_host_rollback_transaction\(\) \{[\s\S]*?\n\}', built).group(0)
                    shell = shell.replace('if apply_update explicit; then exit 2; fi', preserve + r'''
running_gateway_version() { current_version; }
terminal_runtime_is_healthy() { :; }
commit_release_metadata() {
 [ "$FAILURE" != metadata ] || return 1
 printf '{"version":"%s","gitCommit":"''' + SHA + r'''"}' "$version" > "$RELEASE_FILE"
 chmod 644 "$RELEASE_FILE"
 case "$FAILURE" in
   candidate) printf 'wrong\n' > "$UPDATE_TRANSACTION_DIR/candidate-version" ;;
   source) printf '{"version":"%s","gitCommit":"%040d"}' "$version" 0 > "$RELEASE_FILE" ;;
   receipt) printf '{}' > /var/lib/matrix-funded-host-config/receipt.json ;;
   symlink) cp "$UPDATE_TRANSACTION_DIR/same-version-repair.json" /tmp/retained-pin;
     rm "$UPDATE_TRANSACTION_DIR/same-version-repair.json";
     ln -s /tmp/retained-pin "$UPDATE_TRANSACTION_DIR/same-version-repair.json" ;;
 esac
}
clear_consumed_update_markers() { [ "$FAILURE" != interrupted-after-retire ] || exit 77; }
retire_legacy_symphony() { [ "$FAILURE" != symphony ]; }
mark_hermes_reconciliation_pending() { [ "$FAILURE" != hermes ]; }
reconcile_hermes_release() { :; }
remove_legacy_r2_credentials() { [ "$FAILURE" != storage ]; }
funded_host_bootstrap() { [ "$1" != schedule ] || return 0; }
clean_staging() { :; }
restart_sync_agent_after_update() { echo restarted; }
apply_update explicit
''')
                    if failure in ('unlink', 'fsync', 'fsync-shortwrite'):
                        fault = '''import os,sys
original_unlink, original_fsync, original_write = os.unlink, os.fsync, os.write
count = 0
def unlink(name, **kwargs):
    if os.environ['FAILURE'] == 'unlink': raise OSError('injected')
    return original_unlink(name, **kwargs)
def fsync(fd):
    global count
    count += 1
    if os.environ['FAILURE'] in ('fsync', 'fsync-shortwrite') and count == 2: raise OSError('injected')
    return original_fsync(fd)
def write(fd, data):
    if os.environ['FAILURE'] == 'fsync-shortwrite':
        with open('/tmp/retirement-pin-fixture', 'wb') as saved: saved.write(data)
        return original_write(fd, data[:1])
    return original_write(fd, data)
os.unlink, os.fsync, os.write = unlink, fsync, write
exec(compile(sys.stdin.read(), '<actual-emitted-retirement-with-io-fault>', 'exec'))'''
                        shell = shell.replace('if [ "$1" = chown ]; then return 0; fi',
                            'if [ "$1" = chown ]; then return 0; fi\n'
                            ' if [ "$1" = /usr/bin/timeout ] && [ "$#" = 8 ] && [ -n "$8" ]; then\n'
                            '  /usr/bin/python3 -I -c ' + __import__('shlex').quote(fault) + ' "$7" "$8"; return $?\n fi')
                if rollback_fault:
                    fault_function = 'restore_update_transaction' if rollback_fault == 'restore' else 'resume_update_transaction_services'
                    shell = shell.replace('if apply_update explicit; then exit 2; fi',
                                          fault_function + '() { return 1; }\nif apply_update explicit; then exit 2; fi')
                return real_run(['bash', '-c', shell], capture_output=True, timeout=20,
                                env={**os.environ, 'FIXTURE_BUNDLE': bundle.name, 'FAILURE': failure})
        def interrupted_same_version(swapped):
            transaction = Path('/opt/matrix/staging/update-transaction')
            transaction.mkdir(exist_ok=True)
            for name, data in [('state', 'prepared\n'), ('candidate-version', B + '\n'),
                               ('release-metadata', Path('/opt/matrix/release.json').read_text())]:
                (transaction / name).write_text(data)
                os.chmod(transaction / name, 0o644)
            Path('/opt/matrix/staging/update-phase').write_text('terminal-runtime\n')
            os.chmod('/opt/matrix/staging/update-phase', 0o600)
            Path('/opt/matrix/staging/bundle-' + B + '.tar.gz').write_bytes(archive_bytes)
            functions = '\n'.join(re.search(name + r'\(\) \{[\s\S]*?\n\}', built).group(0)
                                  for name in ('write_update_transaction_state', 'seal_update_transaction', 'transaction_candidate_is_committed'))
            shell = recovery_shell() + '\n' + functions + '''
json_field() { python3 -c "import json,sys;print(json.load(sys.stdin).get(sys.argv[1],''))" "$2" <<< "$1"; }
version=''' + B + '''
trigger_source=explicit
seal_update_transaction || exit 2
if transaction_candidate_is_committed "$version"; then exit 4; fi
funded_host_bootstrap recovery-preflight || exit 3
'''
            result = real_run(['bash', '-c', shell], capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            cleaner_functions = '\n'.join(re.search(name + r'\(\) \{[\s\S]*?\n\}', built).group(0)
                                          for name in ('clean_staging', 'clean_staging_now'))
            staged_archive = Path('/opt/matrix/staging/bundle-' + B + '.tar.gz')
            archive_hash = hashlib.sha256(staged_archive.read_bytes()).hexdigest()
            for cleaner in ('clean_staging', 'clean_staging_now'):
                junk = Path('/opt/matrix/staging/bundle-unrelated.tar.gz')
                junk.write_bytes(b'expired irrelevant artifact')
                os.utime(junk, (1, 1))
                os.utime(staged_archive, (1, 1))
                command = recovery_shell() + '\n' + cleaner_functions + '\nSTAGING_ARTIFACT_TTL_SECONDS=60\ndate() { command date "$@"; }\n' + cleaner + '\n'
                cleaned = real_run(['bash', '-c', command], capture_output=True, timeout=20)
                self.assertEqual(cleaned.returncode, 0, cleaned.stderr.decode())
                self.assertTrue(staged_archive.exists(), cleaner + ' removed pending proof archive')
                self.assertEqual(hashlib.sha256(staged_archive.read_bytes()).hexdigest(), archive_hash)
                self.assertFalse(junk.exists())
            pin_file = transaction / 'same-version-repair.json'
            pin_bytes = pin_file.read_bytes()
            owner_file = Path('/home/matrix/home/owner-cleanup-sentinel')
            owner_file.parent.mkdir(parents=True, exist_ok=True)
            owner_file.write_bytes(b'owner data outside staging')
            for invalid in ('malformed', 'duplicate', 'unsealed', 'unknown-version', 'fifo-unsealed'):
                with self.subTest(cleaner_authority=invalid, swapped=swapped):
                    pin_file.write_bytes(pin_bytes)
                    os.chmod(transaction, 0o755)
                    if invalid == 'malformed':
                        pin_file.write_bytes(b'{"receipt": {}}')
                    elif invalid == 'duplicate':
                        pin_file.write_bytes(pin_bytes.replace(b'{', b'{"contractVersion":0,', 1))
                    elif invalid == 'unsealed':
                        os.chmod(transaction, 0o775)
                    elif invalid == 'fifo-unsealed':
                        os.chmod(transaction, 0o775)
                        (transaction / 'candidate-version').unlink()
                        os.mkfifo(transaction / 'candidate-version', 0o644)
                    else:
                        pin = json.loads(pin_bytes)
                        pin['receipt']['version'] = 'unknown-version'
                        pin_file.write_text(json.dumps(pin))
                    staged_archive.write_bytes(archive_bytes)
                    os.utime(staged_archive, (1, 1))
                    cleaned = real_run(['bash', '-c', command], capture_output=True, timeout=3)
                    if invalid == 'fifo-unsealed':
                        (transaction / 'candidate-version').unlink()
                        (transaction / 'candidate-version').write_text(B + '\n')
                        os.chmod(transaction / 'candidate-version', 0o644)
                    self.assertEqual(cleaned.returncode, 0, cleaned.stderr.decode())
                    self.assertEqual(staged_archive.exists(), invalid in ('malformed', 'duplicate', 'unknown-version'))
                    self.assertEqual(owner_file.read_bytes(), b'owner data outside staging')
            pin_file.write_bytes(pin_bytes)
            os.chmod(transaction, 0o755)
            staged_archive.write_bytes(archive_bytes)
            if swapped:
                Path('/opt/matrix/app').rename('/opt/matrix/app.rollback')
                Path('/opt/matrix/app').mkdir()
                Path('/opt/matrix/app/BUNDLE_VERSION').write_text(B + '\n')
            result = real_run(['bash', '-c', recovery_shell() + '\n' + functions + '''
json_field() { python3 -c "import json,sys;print(json.load(sys.stdin).get(sys.argv[1],''))" "$2" <<< "$1"; }
recover_interrupted_update
'''], capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertIn(b'error:apply_interrupted', result.stdout)
            self.assertNotIn(b'already committed', result.stderr)
        with patch.object(http.client.HTTPSConnection, 'request', request), \
             patch.object(http.client.HTTPSConnection, 'getresponse', lambda client: client.mock_response), \
             patch.object(http.client.HTTPSConnection, 'close', lambda client: None), \
             patch.object(socket, 'getaddrinfo', return_value=[(0, 0, 0, '', ('8.8.8.8', 443))]), \
             patch.object(subprocess, 'run', systemctl):
            current(A)
            bootstrap('install', A)
            self.assertEqual(Path('/usr/local/libexec/matrix-funded-host-config.py').read_bytes(), code)
            self.assertEqual(env.read_bytes(), original)
            self.assertEqual(calls, [])
            self.assertFalse(Path('/var/lib/matrix-funded-host-config/invocation.json').exists())
            # The second explicit update has committed B and retained its archive.
            current(B)
            Path('/opt/matrix/staging/bundle-' + B + '.tar.gz').write_bytes(archive_bytes)
            bootstrap('schedule', B)
            before_receipt = Path('/var/lib/matrix-funded-host-config/receipt.json').read_bytes()
            for dependency in ('matrix-terminal-runtime.service', 'matrix-scope-runtime.service'):
                for previous_state in ('inactive', 'failed'):
                    states[dependency] = previous_state
                    calls.clear()
                    with self.assertRaises(SystemExit):
                        installed('--maintenance')
                    self.assertFalse(any(call[0] in ('start', 'stop') for call in calls))
                    self.assertEqual(env.read_bytes(), original)
                    self.assertEqual(Path('/var/lib/matrix-funded-host-config/receipt.json').read_bytes(), before_receipt)
                    self.assertFalse(Path('/var/lib/matrix-funded-host-config/resume.json').exists())
                    self.assertEqual(list(env.parent.glob('host.env.funded-*.json')), [])
                    states[dependency] = 'active'
                    bootstrap('retry', B)
            fail_after_journal = True
            with self.assertRaises(SystemExit):
                installed('--maintenance')
            self.assertEqual(env.read_bytes(), original)
            self.assertFalse(Path('/var/lib/matrix-funded-host-config/applied.json').exists())
            preserved = {p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}
            self.assertEqual(len(preserved), 1)
            # Run actual installed ExecStopPost entry after a failed restoration;
            # unchanged journal evidence survives until a later successful retry.
            resume_file = Path('/var/lib/matrix-funded-host-config/resume.json')
            with patch.object(sys, 'argv', ['/usr/local/libexec/matrix-funded-host-config.py', '--resume']):
                generated = runpy.run_path('/usr/local/libexec/matrix-funded-host-config.py', run_name='__main__')
            state = generated['Directory']('/', ('var', 'lib', 'matrix-funded-host-config'))
            try:
                record = generated['resume_record'](state, [s for s in SERVICES if states[s] == 'active'],
                                                     json.loads(state.read('receipt.json')))
            finally:
                state.close()
            resume_file.write_text(json.dumps(record))
            os.chmod(resume_file, 0o600)
            resume_bytes = resume_file.read_bytes()
            for service in states:
                states[service] = 'inactive'
            failed_resume = True
            with self.assertRaises(SystemExit):
                installed('--resume')
            self.assertEqual(resume_file.read_bytes(), resume_bytes)
            self.assertEqual(states['matrix-sync-agent.service'], 'inactive')
            bootstrap('retry', B)
            calls.clear()
            with self.assertRaises(SystemExit):
                installed('--maintenance')
            self.assertEqual(resume_file.read_bytes(), resume_bytes)
            self.assertFalse(any(call[0] in ('stop', 'start') for call in calls))
            self.assertEqual(env.read_bytes(), original)
            failed_resume = False
            installed('--resume')
            self.assertFalse(resume_file.exists())
            # Execute emitted maintenance through a real write followed by an
            # unavailable inspection. Its baseline authorizes only Sync until an
            # independent exact prior-image restoration makes full resume safe.
            bootstrap('retry', B)
            unsafe_environment = True
            calls.clear()
            with self.assertRaises(SystemExit):
                installed('--maintenance')
            intent = resume_file.read_bytes()
            self.assertEqual(set(json.loads(intent)), {'services', 'version', 'sourceSha', 'receiptSha256', 'beforeSha256', 'safeEnvSha256'})
            self.assertEqual(json.loads(intent)['beforeSha256'], hashlib.sha256(original).hexdigest())
            self.assertEqual(states['matrix-sync-agent.service'], 'active')
            self.assertTrue(all(states[s] == 'inactive' for s in SERVICES[:-1]))
            self.assertFalse(any(call[0] == 'start' and call[-1] != 'matrix-sync-agent.service' for call in calls))
            unknown_journals = {p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}
            unknown_applied = Path('/var/lib/matrix-funded-host-config/applied.json').read_bytes()
            with self.assertRaises(SystemExit):
                installed('--resume')
            self.assertEqual(resume_file.read_bytes(), intent)
            self.assertTrue(all(states[s] == 'inactive' for s in SERVICES[:-1]))
            env.write_bytes(original)  # Independent recovery fixture, no bypass.
            unsafe_environment = False
            installed('--resume')
            self.assertFalse(resume_file.exists())
            self.assertTrue(all(states[s] == 'active' for s in SERVICES if s != 'matrix-symphony.service'))
            self.assertEqual(env.read_bytes(), original)
            self.assertEqual({p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}, unknown_journals)
            self.assertEqual(Path('/var/lib/matrix-funded-host-config/applied.json').read_bytes(), unknown_applied)
            for service in states:
                states[service] = 'inactive'
            installed('--rollback')
            for service in states:
                states[service] = 'inactive' if service == 'matrix-symphony.service' else 'active'
            preserved = unknown_journals
            applied_file = Path('/var/lib/matrix-funded-host-config/applied.json')
            local_identity = {'handle': IDENTITY['handle'], 'machineId': IDENTITY['machineId'],
                              'ownerId': 'user_test', 'runtimeSlot': 'primary', 'epoch': 2}
            for prior_id in ('repair-' + 'f' * 32, '../invalid', None):
                intent = {} if prior_id is None else {'rolloutId': prior_id, 'identity': local_identity,
                                                     'beforeSha256': hashlib.sha256(original).hexdigest()}
                applied_file.write_text(json.dumps(intent))
                os.chmod(applied_file, 0o600)
                marker_bytes = applied_file.read_bytes()
                bootstrap('retry', B)
                calls.clear()
                with self.assertRaises(SystemExit):
                    installed('--maintenance')
                self.assertEqual(applied_file.read_bytes(), marker_bytes)
                self.assertEqual(env.read_bytes(), original)
                self.assertEqual({p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}, preserved)
                self.assertFalse(any(call[0] == 'stop' for call in calls))
                applied_file.unlink()
            bootstrap('retry', B)
            delayed_start = True
            delayed_stop = True
            def advance(seconds):
                restore_clock[0] += seconds
            with patch.object(time, 'monotonic', lambda: restore_clock[0]), patch.object(time, 'sleep', advance):
                installed('--maintenance')
            delayed_start = False
            delayed_stop = False
            pending.clear()
            self.assertEqual(pending_stops, {})
            self.assertGreater(restore_clock[0], 1485)
            applied = env.read_bytes()
            self.assertIn(b'MATRIX_FUNDED_AI_ENABLED=true\n', applied)
            self.assertIn(b'UNRELATED="literal $value"\n', applied)
            self.assertEqual(states['matrix-symphony.service'], 'inactive')
            self.assertTrue(all(states[name] == 'active' for name in SERVICES if name != 'matrix-symphony.service'))
            self.assertEqual(len(list(env.parent.glob('host.env.funded-*.json'))), len(preserved) + 1)
            for name, data in preserved.items():
                self.assertEqual((env.parent / name).read_bytes(), data)
            # Exact desired state: no second restart or backup.
            calls.clear()
            active_marker = Path('/var/lib/matrix-funded-host-config/applied.json').read_bytes()
            with open('/var/lib/matrix-funded-host-config/attempt.lock', 'rb') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(SystemExit):
                    installed('--rollback')
            self.assertEqual(Path('/var/lib/matrix-funded-host-config/applied.json').read_bytes(), active_marker)
            bootstrap('retry', B, 'raced')
            receipt_file = Path('/var/lib/matrix-funded-host-config/receipt.json')
            receipt_bytes = receipt_file.read_bytes()
            for missing in (False, True):
                try:
                    if missing:
                        receipt_file.unlink()
                    else:
                        receipt_file.write_text('{}')
                    requests_before = len(requests)
                    with self.assertRaises(SystemExit):
                        bootstrap('retry', B)
                    self.assertEqual(len(requests), requests_before)
                    self.assertFalse(Path('/opt/matrix/app/.update-now').exists())
                    self.assertFalse(Path('/var/lib/matrix-funded-host-config/invocation.json').exists())
                finally:
                    receipt_file.write_bytes(receipt_bytes)
                    os.chmod(receipt_file, 0o600)
            bootstrap('schedule', B)
            installed('--maintenance')
            self.assertFalse(any(call[0] == 'stop' for call in calls))
            self.assertEqual(env.read_bytes(), applied)
            self.assertEqual(Path('/var/lib/matrix-funded-host-config/applied.json').read_bytes(), active_marker)
            # Run the emitted apply lifecycle, including real sealed same-version
            # proof and real app swaps. Success retires only the completed pin;
            # its manual rollback transaction and prior app remain available.
            result = failed_update('', same_version=True, success=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            transaction = Path('/opt/matrix/staging/update-transaction')
            self.assertFalse((transaction / 'same-version-repair.json').exists())
            self.assertFalse(Path('/opt/matrix/staging/update-phase').exists())
            self.assertEqual(json.loads((transaction / 'release-metadata').read_text())['version'], B)
            self.assertEqual(Path('/opt/matrix/app.rollback/BUNDLE_VERSION').read_text(), B + '\n')
            checked = real_run(['bash', '-c', recovery_shell() + '\nrelease_metadata_matches_app "$APP_DIR.rollback" "$UPDATE_TRANSACTION_DIR/release-metadata"\n'], capture_output=True, timeout=20)
            self.assertEqual(checked.returncode, 0, checked.stderr.decode())
            result = failed_update('', success=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertIn(b'Installed app v-test-candidate-c', result.stderr)
            self.assertEqual(Path('/opt/matrix/app/BUNDLE_VERSION').read_text(), 'v-test-candidate-c\n')
            self.assertEqual(json.loads(Path('/opt/matrix/release.json').read_text())['version'], 'v-test-candidate-c')
            self.assertEqual(env.read_bytes(), applied)
            self.assertEqual(Path('/var/lib/matrix-funded-host-config/applied.json').read_bytes(), active_marker)
            shutil.rmtree('/opt/matrix/app')
            Path('/opt/matrix/app.rollback').rename('/opt/matrix/app')
            current(B)
            shutil.rmtree(transaction)
            # Secondary post-metadata failures and failed retirement must retain
            # phase/pin/archive; none may masquerade as verified completion.
            for failure in ('symphony', 'hermes', 'storage', 'candidate', 'source', 'receipt', 'symlink', 'unlink', 'fsync', 'fsync-shortwrite'):
                with self.subTest(completion_failure=failure):
                    evidence = {p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}
                    result = failed_update(failure, same_version=True, success=True)
                    self.assertEqual(result.returncode, 1, result.stderr.decode())
                    pin = transaction / 'same-version-repair.json'
                    self.assertTrue(pin.exists())
                    self.assertTrue(Path('/opt/matrix/staging/update-phase').exists())
                    archive = Path('/opt/matrix/staging/bundle-' + B + '.tar.gz')
                    self.assertEqual(archive.read_bytes(), archive_bytes)
                    if failure == 'fsync-shortwrite':
                        cleaners = '\n'.join(re.search(name + r'\(\) \{[\s\S]*?\n\}', built).group(0)
                                            for name in ('clean_staging', 'clean_staging_now'))
                        for damaged in (pin.read_bytes(), b'', b'not-json', None):
                            if damaged is None:
                                pin.unlink()
                                pin.symlink_to('/tmp/retirement-pin-fixture')
                            else:
                                pin.write_bytes(damaged)
                            os.utime(archive, (1, 1))
                            for cleaner in ('clean_staging', 'clean_staging_now'):
                                cleaned = real_run(['bash', '-c', recovery_shell() + '\n' + cleaners + '\nSTAGING_ARTIFACT_TTL_SECONDS=60\ndate() { command date "$@"; }\n' + cleaner + '\n'], capture_output=True, timeout=20)
                                self.assertEqual(cleaned.returncode, 0, cleaned.stderr.decode())
                                self.assertEqual(archive.read_bytes(), archive_bytes)
                            blocked = failed_update('', success=True)
                            self.assertEqual(blocked.returncode, 1)
                            self.assertNotIn(b'Downloading bundle', blocked.stderr)
                            if damaged is None:
                                self.assertTrue(pin.is_symlink())
                            else:
                                self.assertEqual(pin.read_bytes(), damaged)
                        pin.unlink()
                        pin.write_bytes(Path('/tmp/retirement-pin-fixture').read_bytes())
                    if failure == 'symlink':
                        self.assertEqual(Path('/tmp/retained-pin').read_bytes(), pin.read_bytes())
                        pin.unlink()
                        pin.write_bytes(Path('/tmp/retained-pin').read_bytes())
                        os.chmod(pin, 0o644)
                    current(B)
                    receipt_file.write_bytes(receipt_bytes)
                    (transaction / 'candidate-version').write_text(B + '\n')
                    recovered = real_run(['bash', '-c', recovery_shell() + '\nrecover_interrupted_update\n'], capture_output=True, timeout=20)
                    self.assertEqual(recovered.returncode, 0, recovered.stderr.decode())
                    self.assertIn(b'error:apply_interrupted', recovered.stdout)
                    self.assertTrue(transaction.exists())
                    self.assertFalse((transaction / 'same-version-repair.json').exists())
                    self.assertFalse(Path('/opt/matrix/staging/update-phase').exists())
                    self.assertEqual(env.read_bytes(), applied)
                    self.assertEqual(Path('/var/lib/matrix-funded-host-config/applied.json').read_bytes(), active_marker)
                    self.assertEqual({p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}, evidence)
            # Process death after verified retirement still leaves an active
            # phase. Absence of a pin alone grants neither commit nor new apply.
            result = failed_update('interrupted-after-retire', same_version=True, success=True)
            self.assertEqual(result.returncode, 77, result.stderr.decode())
            self.assertFalse((transaction / 'same-version-repair.json').exists())
            self.assertTrue(Path('/opt/matrix/staging/update-phase').exists())
            archive = Path('/opt/matrix/staging/bundle-' + B + '.tar.gz')
            archive_before = archive.read_bytes()
            os.utime(archive, (1, 1))
            cleaners = '\n'.join(re.search(name + r'\(\) \{[\s\S]*?\n\}', built).group(0)
                                    for name in ('clean_staging', 'clean_staging_now'))
            for cleaner in ('clean_staging', 'clean_staging_now'):
                cleaned = real_run(['bash', '-c', recovery_shell() + '\n' + cleaners + '\nSTAGING_ARTIFACT_TTL_SECONDS=60\ndate() { command date "$@"; }\n' + cleaner + '\n'], capture_output=True, timeout=20)
                self.assertEqual(cleaned.returncode, 0, cleaned.stderr.decode())
                self.assertEqual(archive.read_bytes(), archive_before)
            retained = {p.name: p.read_bytes() for p in transaction.iterdir() if p.is_file()}
            result = failed_update('', success=True)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn(b'Downloading bundle', result.stderr)
            self.assertEqual({p.name: p.read_bytes() for p in transaction.iterdir() if p.is_file()}, retained)
            recovered = real_run(['bash', '-c', recovery_shell() + '\nrecover_interrupted_update\n'], capture_output=True, timeout=20)
            self.assertIn(b'error:post_install_rollback_failed', recovered.stdout)
            self.assertTrue(transaction.exists())
            self.assertTrue(Path('/opt/matrix/staging/update-phase').exists())
            shutil.rmtree('/opt/matrix/app')
            Path('/opt/matrix/app.rollback').rename('/opt/matrix/app')
            current(B)
            shutil.rmtree(transaction)
            Path('/opt/matrix/staging/update-phase').unlink()
            result = failed_update('preflight', same_version=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertNotIn(b'Stopping services', result.stderr)
            self.assertTrue(transaction.exists())
            self.assertFalse(Path('/opt/matrix/staging/update-phase').exists(), 'confirmed pre-stop cleanup must retire phase')
            result = failed_update('terminal-helper', same_version=True)
            self.assertIn(b'error:terminal_runtime_helper_install_failed', result.stdout)
            self.assertFalse(Path('/opt/matrix/staging/update-phase').exists(), 'healthy completed rollback must retire phase')
            for failure, error in [('terminal-helper', 'terminal_runtime_helper_install_failed'),
                                   ('gateway-health', 'post_install_health_failed')]:
                result = failed_update(failure, same_version=True)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertIn(('error:' + error).encode(), result.stdout, result.stderr.decode())
                self.assertNotIn(b'update_transaction_prepare_failed', result.stdout)
                self.assertIn(b'resumed', result.stdout)
                self.assertEqual(Path('/opt/matrix/app/BUNDLE_VERSION').read_text(), B + '\n')
                self.assertEqual(env.read_bytes(), applied)
                self.assertEqual(Path('/var/lib/matrix-funded-host-config/applied.json').read_bytes(), active_marker)
            # Apply failure cleanup must retain the exact archive needed by a
            # later protected retry when restoration or startup fails once.
            for failure in ('terminal-helper', 'gateway-health'):
                for fault in ('restore', 'resume'):
                    with self.subTest(apply_failure=failure, rollback_fault=fault):
                        journal_bytes = {p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}
                        result = failed_update(failure, same_version=True, rollback_fault=fault)
                        self.assertEqual(result.returncode, 0, result.stderr.decode())
                        self.assertIn(b'error:post_install_rollback_failed', result.stdout)
                        archive = Path('/opt/matrix/staging/bundle-' + B + '.tar.gz')
                        self.assertTrue(archive.exists(), 'failed rollback discarded its protected retry archive')
                        self.assertEqual(archive.read_bytes(), archive_bytes)
                        self.assertTrue(Path('/opt/matrix/staging/update-transaction/same-version-repair.json').exists())
                        # A later apply must not overwrite/delete this archive
                        # or replace its transaction while recovery is pending.
                        transaction = Path('/opt/matrix/staging/update-transaction')
                        retained = {p.name: p.read_bytes() for p in transaction.iterdir() if p.is_file()}
                        blocked = failed_update('terminal-helper', same_version=True)
                        self.assertIn(b'error:post_install_rollback_failed', blocked.stdout)
                        self.assertEqual(archive.read_bytes(), archive_bytes)
                        self.assertEqual({p.name: p.read_bytes() for p in transaction.iterdir() if p.is_file()}, retained)
                        retry = real_run(['bash', '-c', recovery_shell() + '\nrecover_interrupted_update\n'],
                                         capture_output=True, timeout=20)
                        self.assertEqual(retry.returncode, 0, retry.stderr.decode())
                        self.assertIn(b'error:apply_interrupted', retry.stdout)
                        self.assertTrue(Path('/opt/matrix/staging/update-transaction').exists())
                        self.assertFalse(Path('/opt/matrix/staging/update-phase').exists())
                        cleaner = re.search(r'clean_staging_now\(\) \{[\s\S]*?\n\}', built).group(0)
                        cleaned = real_run(['bash', '-c', recovery_shell() + '\n' + cleaner + '\nclean_staging_now\n'],
                                           capture_output=True, timeout=20)
                        self.assertEqual(cleaned.returncode, 0, cleaned.stderr.decode())
                        self.assertFalse(archive.exists(), 'resolved transaction leaked its staging archive')
                        self.assertEqual(env.read_bytes(), applied)
                        self.assertEqual(Path('/var/lib/matrix-funded-host-config/applied.json').read_bytes(), active_marker)
                        self.assertEqual({p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}, journal_bytes)
            for swapped in (False, True):
                journal_bytes = {p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}
                interrupted_same_version(swapped)
                self.assertEqual(env.read_bytes(), applied)
                self.assertEqual({p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}, journal_bytes)
                self.assertEqual(Path('/var/lib/matrix-funded-host-config/applied.json').read_bytes(), active_marker)
            Path('/opt/matrix/app.rollback').mkdir()
            Path('/opt/matrix/app.rollback/BUNDLE_VERSION').write_text(A + '\n')
            applied_file = Path('/var/lib/matrix-funded-host-config/applied.json')
            saved_applied = applied_file.read_bytes()
            try:
                applied_file.write_text('{}')
                result = failed_update('gateway-health')
                self.assertIn(b'error:update_transaction_prepare_failed', result.stdout)
                self.assertNotIn(b'stopped', result.stdout)
                self.assertEqual(Path('/opt/matrix/app/BUNDLE_VERSION').read_text(), B + '\n')
            finally:
                applied_file.write_bytes(saved_applied)
            for failure, error in [('terminal-helper', 'terminal_runtime_helper_install_failed'),
                                   ('terminal-start', 'post_install_terminal_start_failed'),
                                   ('gateway-health', 'post_install_health_failed')]:
                result = failed_update(failure)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertIn(('error:' + error).encode(), result.stdout)
                self.assertEqual(Path('/opt/matrix/app/BUNDLE_VERSION').read_text(), B + '\n')
                self.assertEqual(env.read_bytes(), applied)
            # Failed later candidates recover to the release still owning the
            # unchanged funded configuration, both before and after app swap.
            for swapped in (False, True):
                result = failed_candidate_recovery('v-test-candidate-c', swapped)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(Path('/opt/matrix/app/BUNDLE_VERSION').read_text(), B + '\n')
                self.assertEqual(env.read_bytes(), applied)
                self.assertTrue(Path('/var/lib/matrix-funded-host-config/applied.json').exists())
            # Initial manual=true is denied even if legacy metadata fallback
            # could otherwise convert it to automatic=false.
            denied = failed_candidate_recovery('v-test-candidate-c', False, manual=True)
            self.assertNotEqual(denied.returncode, 0)
            self.assertNotIn(b'stopped', denied.stdout)
            applied_file = Path('/var/lib/matrix-funded-host-config/applied.json')
            receipt_file = Path('/var/lib/matrix-funded-host-config/receipt.json')
            journal_file = env.parent / ('host.env.funded-' + json.loads(applied_file.read_text())['rolloutId'] + '.json')
            protected = Path('/usr/local/libexec/matrix-funded-host-config.py')
            unit_file = Path('/etc/systemd/system/matrix-funded-host-config.service')
            release_file = Path('/opt/matrix/release.json')
            def altered_json(path, change):
                value = json.loads(path.read_text())
                change(value)
                path.write_text(json.dumps(value))
            # Each independent corruption must defer before stopping services;
            # actual protected entry validation runs with no network request.
            corruptions = [
                (applied_file, lambda _: applied_file.write_text('{}')),
                (journal_file, lambda _: journal_file.write_text('{}')),
                (journal_file, lambda _: altered_json(journal_file, lambda v: v.update(original='bad'))),
                (env, lambda _: env.write_bytes(applied + b'# changed\n')),
                (env, lambda _: env.write_bytes(applied.replace(b'TOKEN_EPOCH=2', b'TOKEN_EPOCH=3'))),
                (applied_file, lambda _: altered_json(applied_file, lambda v: v['identity'].update(ownerId='wrong'))),
                (receipt_file, lambda _: altered_json(receipt_file, lambda v: v.update(sourceSha='b' * 40))),
                (release_file, lambda _: altered_json(release_file, lambda v: v.update(gitCommit='b' * 40))),
                (protected, lambda _: protected.write_bytes(code + b'# corrupt\n')),
                (unit_file, lambda _: unit_file.write_bytes(unit + b'# corrupt\n')),
                (None, lambda t: (t / 'release-metadata').write_text('{}')),
                (None, lambda t: (t / 'candidate-version').write_text(B + '\n')),
                (None, lambda t: (t / 'state').write_text('committed\n')),
            ]
            for path, mutate in corruptions:
                saved = path.read_bytes() if path else None
                try:
                    result = failed_candidate_recovery('v-test-candidate-c', False, mutate=mutate, preflight=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn(b'stopped', result.stdout)
                finally:
                    if path:
                        path.write_bytes(saved)
            for lock_path in ('/var/lib/matrix-funded-host-config/install.lock',
                              '/opt/matrix/env/.host.env.funded-repair.lock'):
                with open(lock_path, 'rb') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    result = failed_candidate_recovery('v-test-candidate-c', False, preflight=True)
                    self.assertNotEqual(result.returncode, 0)
            # Wrong rollback app is rejected; retry after interrupted restoration
            # uses current app and never selects an unrelated older app snapshot.
            result = failed_candidate_recovery('v-test-candidate-c', mutate=lambda _: Path(
                '/opt/matrix/app.rollback/BUNDLE_VERSION').write_text('wrong\n'))
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'stopped', result.stdout)
            Path('/opt/matrix/app.rollback/BUNDLE_VERSION').write_text(B + '\n')
            result = failed_candidate_recovery('v-test-candidate-c', False, restore_failure=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(Path('/opt/matrix/app/BUNDLE_VERSION').read_text(), B + '\n')
            result = failed_candidate_recovery('v-test-candidate-c', False, interrupted=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertIn(b'error:apply_interrupted', result.stdout)
            self.assertEqual(env.read_bytes(), applied)
            result = failed_candidate_recovery('v-test-candidate-c', move_failure=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'resumed', result.stdout)
            self.assertEqual(Path('/opt/matrix/app/BUNDLE_VERSION').read_text(), 'v-test-candidate-c\n')
            result = failed_candidate_recovery('v-test-candidate-c', False)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            def remove_candidate(_):
                Path('/opt/matrix/app/BUNDLE_VERSION').unlink()
                Path('/opt/matrix/app').rmdir()
            result = failed_candidate_recovery('v-test-candidate-c', mutate=remove_candidate)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(Path('/opt/matrix/app/BUNDLE_VERSION').read_text(), B + '\n')
            result = failed_candidate_recovery('v-test-candidate-c', changed_after_restore=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'resumed', result.stdout)
            env.write_bytes(applied)
            result = failed_candidate_recovery('v-test-candidate-c', False)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            bootstrap('rollback', B, A)
            installed('--maintenance')
            self.assertEqual(env.read_bytes(), original)
            self.assertFalse(Path('/var/lib/matrix-funded-host-config/applied.json').exists())
            self.assertFalse(Path('/var/lib/matrix-funded-host-config/invocation.json').exists())
            self.assertEqual(json.loads(Path('/var/lib/matrix-funded-host-config/receipt.json').read_text())['version'], B)
            preserved = {p.name: p.read_bytes() for p in env.parent.glob('host.env.funded-*.json')}
            bootstrap('schedule', B)
            installed('--maintenance')
            self.assertEqual(env.read_bytes(), applied)
            self.assertEqual(len(list(env.parent.glob('host.env.funded-*.json'))), len(preserved) + 1)
            for name, data in preserved.items():
                self.assertEqual((env.parent / name).read_bytes(), data)
            bootstrap('rollback', B, A)
            installed('--maintenance')
            self.assertEqual(env.read_bytes(), original)
            # The config-free first artifact is restored separately and startup is inert.
            current(A)
            bootstrap('install', A)
            self.assertEqual(env.read_bytes(), original)
            self.assertFalse(Path('/var/lib/matrix-funded-host-config/invocation.json').exists())
            self.assertNotIn('[Install]', Path('/etc/systemd/system/matrix-funded-host-config.service').read_text())
            self.assertFalse(Path('/tmp/funded-attacker-executed').exists())
            # A successful later update installs a new current receipt. The
            # original complete apply journal remains valid independent of its
            # rolloutId's original version; the next failed candidate recovers.
            current('v-test-successful-d')
            Path('/opt/matrix/staging/bundle-v-test-successful-d.tar.gz').write_bytes(archive_bytes)
            bootstrap('schedule', 'v-test-successful-d')
            installed('--maintenance')
            current('v-test-successful-e')
            bootstrap('install', 'v-test-successful-e')
            result = failed_candidate_recovery('v-test-candidate-f')
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(Path('/opt/matrix/app/BUNDLE_VERSION').read_text(), 'v-test-successful-e\n')
            self.assertEqual(json.loads(receipt_file.read_text())['version'], 'v-test-successful-e')
            self.assertEqual(env.read_bytes(), applied)
            self.assertTrue(applied_file.exists())
            # Historical release-derived IDs still select their complete journal
            # for read-only recovery and subsequent guarded field rollback.
            marker = json.loads(applied_file.read_text())
            active = env.parent / ('host.env.funded-' + marker['rolloutId'] + '.json')
            marker['rolloutId'] = 'repair-' + hashlib.sha256(b'v-test-successful-d').hexdigest()[:24]
            legacy = env.parent / ('host.env.funded-' + marker['rolloutId'] + '.json')
            legacy.write_bytes(active.read_bytes())
            os.chmod(legacy, 0o600)
            applied_file.write_text(json.dumps(marker))
            result = failed_candidate_recovery('v-test-candidate-f')
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            bootstrap('rollback', 'v-test-successful-e', 'v-test-successful-d')
            installed('--maintenance')
            self.assertEqual(env.read_bytes(), original)
            self.assertEqual(legacy.read_bytes(), active.read_bytes())


if __name__ == '__main__':
    unittest.main()

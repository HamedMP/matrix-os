"""Generated protected program integration in disposable root Linux.

Network/DNS and systemctl are mocks. Archive hashing, protected installation,
program entry, environment writes, journals and rollback use real root paths.
Run only in disposable network-disabled container, never on an actual host.
"""
import grp
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import re
import runpy
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
        try:
            gid = grp.getgrnam('matrix').gr_gid
        except KeyError:
            subprocess.run(['/usr/sbin/groupadd', 'matrix'], check=True)
            gid = grp.getgrnam('matrix').gr_gid
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
            built = agent.read_text()
            inline = re.search(r"<<'MATRIX_FUNDED_VERIFIED_BOOTSTRAP'\n([\s\S]*?)\nMATRIX_FUNDED_VERIFIED_BOOTSTRAP", built).group(1)
            # Use the exact emitted inline Python, not a rewritten implementation.
            code = (component / 'reconcile.py').read_bytes()
            unit = (component / 'matrix-funded-host-config.service').read_bytes()
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                for name, data in [('funded-host-config/reconcile.py', code),
                                   ('funded-host-config/matrix-funded-host-config.service', unit)]:
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
        calls, requests = [], []
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
            if args[0] != '/usr/bin/systemctl':
                return real_run(args, **kwargs)
            calls.append(tuple(args[1:]))
            action, service = args[1], args[-1]
            output = ''
            if action == 'show': output = 'loaded' if 'LoadState' in args[2] else 'control-group'
            elif action == 'is-active': output = states[service]
            elif action in ('stop', 'start') and service in states:
                states[service] = 'inactive' if action == 'stop' else 'active'
            return subprocess.CompletedProcess(args, 0, output.encode(), b'')
        def bootstrap(operation, selected, prior=''):
            with patch.object(sys, 'argv', ['-', operation, selected, prior]):
                exec(compile(inline, '<actual-generated-inline-bootstrap>', 'exec'), {'__name__': '__main__'})
        def installed(action):
            with patch.object(sys, 'argv', ['/usr/local/libexec/matrix-funded-host-config.py', action]):
                runpy.run_path('/usr/local/libexec/matrix-funded-host-config.py', run_name='__main__')
        def current(selected):
            Path('/opt/matrix/release.json').write_text(json.dumps({'version': selected, 'gitCommit': SHA}))
            os.chmod('/opt/matrix/release.json', 0o644)
            Path('/opt/matrix/app/BUNDLE_VERSION').write_text(selected + '\n')
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
            installed('--maintenance')
            applied = env.read_bytes()
            self.assertIn(b'MATRIX_FUNDED_AI_ENABLED=true\n', applied)
            self.assertIn(b'UNRELATED="literal $value"\n', applied)
            self.assertEqual(states['matrix-symphony.service'], 'inactive')
            self.assertTrue(all(states[name] == 'active' for name in SERVICES if name != 'matrix-symphony.service'))
            self.assertEqual(len(list(env.parent.glob('host.env.funded-*.json'))), 1)
            # Exact desired state: no second restart or backup.
            calls.clear()
            bootstrap('schedule', B)
            installed('--maintenance')
            self.assertFalse(any(call[0] == 'stop' for call in calls))
            self.assertEqual(env.read_bytes(), applied)
            bootstrap('rollback', B, A)
            installed('--maintenance')
            self.assertEqual(env.read_bytes(), original)
            self.assertFalse(Path('/var/lib/matrix-funded-host-config/applied.json').exists())
            self.assertFalse(Path('/var/lib/matrix-funded-host-config/invocation.json').exists())
            self.assertEqual(json.loads(Path('/var/lib/matrix-funded-host-config/receipt.json').read_text())['version'], B)
            # The config-free first artifact is restored separately and startup is inert.
            current(A)
            bootstrap('install', A)
            self.assertEqual(env.read_bytes(), original)
            self.assertFalse(Path('/var/lib/matrix-funded-host-config/invocation.json').exists())
            self.assertNotIn('[Install]', Path('/etc/systemd/system/matrix-funded-host-config.service').read_text())
            self.assertFalse(Path('/tmp/funded-attacker-executed').exists())


if __name__ == '__main__':
    unittest.main()

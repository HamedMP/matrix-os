"""Same immutable artifact recovery; protected proof never rolls back funds."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sys
import tarfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('repair_fixture', Path(__file__).with_name('funded-host-component.test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
runtime, installer = fixture.runtime, fixture.installer


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').is_dir(), 'disposable root Linux only')
class ArtifactRepairTests(unittest.TestCase):
    setUp = fixture.RootLifecycleTests.setUp
    tearDown = fixture.RootLifecycleTests.tearDown
    admission = fixture.RootLifecycleTests.admission

    def prepare(self):
        installer.install(fixture.VERSION, fixture.SHA)
        self.admission()
        runtime.maintenance()
        staging = Path(self.root + '/opt/matrix/staging')
        self.transaction = staging / 'update-transaction'
        self.transaction.mkdir(mode=0o755)
        phase = staging / 'update-phase'
        phase.write_text('terminal-runtime\n')
        phase.chmod(0o600)
        receipt = json.loads(Path(self.root + '/var/lib/matrix-funded-host-config/receipt.json').read_text())
        info = Path(self.root + '/opt/matrix/app').stat()
        self.pin = {'kind': 'matrix-same-version-artifact-repair', 'contractVersion': 1,
                    'receipt': receipt, 'appDevice': info.st_dev, 'appInode': info.st_ino}
        for name, value in [('state', 'mutating\n'), ('candidate-version', fixture.VERSION + '\n'),
                            ('release-metadata', json.dumps(self.current)),
                            ('same-version-repair.json', json.dumps(self.pin))]:
            path = self.transaction / name
            path.write_text(value)
            path.chmod(0o644)
        self.archive = staging / ('bundle-' + fixture.VERSION + '.tar.gz')
        self.archive.write_bytes(self.bytes)
        self.archive.chmod(0o644)
        self.env_after = Path(self.env).read_bytes()
        self.journals = {p.name: p.read_bytes() for p in Path(self.env).parent.glob('host.env.funded-*.json')}

    def preserved(self):
        self.assertEqual(Path(self.env).read_bytes(), self.env_after)
        self.assertEqual({p.name: p.read_bytes() for p in Path(self.env).parent.glob('host.env.funded-*.json')}, self.journals)
        self.assertFalse(list(Path(self.root + '/var/lib/matrix-funded-host-config').glob('.archive-*')))

    def test_exact_same_version_repair_proof_before_and_after_app_swap(self):
        self.prepare()
        self.calls.clear()
        before = self.responses
        runtime.recovery_proof(True)
        app = Path(self.root + '/opt/matrix/app')
        app.rename(app.with_name('app.rollback'))
        app.mkdir()
        (app / 'BUNDLE_VERSION').write_text(fixture.VERSION + '\n')
        runtime.recovery_proof(False)
        with self.assertRaises(installer.ConfigError):
            runtime.recovery_proof(True)
        self.preserved()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.responses, before)

    def test_missing_or_bad_pin_archive_source_component_and_inode_defer(self):
        self.prepare()
        pin_path = self.transaction / 'same-version-repair.json'
        original = pin_path.read_bytes()
        for alteration in ('missing', 'kind', 'source', 'checksum', 'component', 'unit', 'inode', 'extra'):
            with self.subTest(alteration=alteration):
                value = json.loads(original)
                if alteration == 'missing':
                    pin_path.unlink()
                else:
                    if alteration in ('source', 'checksum', 'component', 'unit'):
                        key = {'source': 'sourceSha', 'checksum': 'archiveSha256', 'component': 'componentSha256', 'unit': 'unitSha256'}[alteration]
                        value['receipt'][key] = 'b' * (40 if alteration == 'source' else 64)
                    elif alteration == 'kind': value['kind'] = 'manual-rollback'
                    elif alteration == 'inode': value['appInode'] += 1
                    else: value['command'] = 'id'
                    pin_path.write_text(json.dumps(value))
                with self.assertRaises((installer.ConfigError, FileNotFoundError)):
                    runtime.recovery_proof(True)
                pin_path.write_bytes(original)
                self.preserved()
        archive_bytes = self.archive.read_bytes()
        self.archive.write_bytes(archive_bytes + b'changed')
        with self.assertRaises(installer.ConfigError): runtime.recovery_proof(True)
        self.archive.write_bytes(archive_bytes)
        self.archive.unlink()
        with self.assertRaises(FileNotFoundError): runtime.recovery_proof(True)
        self.preserved()

    def test_same_hash_snapshot_still_requires_exact_component_and_unit(self):
        self.prepare()
        receipt_path = Path(self.root + '/var/lib/matrix-funded-host-config/receipt.json')
        pin_path = self.transaction / 'same-version-repair.json'
        for changed in ('funded-host-config/reconcile.py', 'funded-host-config/matrix-funded-host-config.service'):
            receipt = dict(self.pin['receipt'])
            members = [(name, b'wrong' if name == changed else (Path(fixture.ROOT) /
                        ('distro/customer-vps/funded-host-config/reconcile.py' if name.endswith('reconcile.py') else
                         'distro/customer-vps/funded-host-config/matrix-funded-host-config.service')).read_bytes(), tarfile.REGTYPE)
                       for name in installer.MEMBERS]
            data = fixture.archive(members)
            receipt['archiveSha256'] = hashlib.sha256(data).hexdigest()
            receipt_path.write_text(json.dumps(receipt))
            pin_path.write_text(json.dumps(dict(self.pin, receipt=receipt)))
            self.archive.write_bytes(data)
            with self.assertRaises(installer.ConfigError):
                runtime.recovery_proof(True)
            self.preserved()


if __name__ == '__main__':
    unittest.main()

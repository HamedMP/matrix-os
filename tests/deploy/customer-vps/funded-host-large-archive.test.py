"""Canonical-sized archive regressions; run only in GitHub's disposable fixture."""
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('large_archive_installer', ROOT / 'distro/customer-vps/funded-host-config/install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class LargeArchiveTests(unittest.TestCase):
    def archive(self, count, duplicate=False):
        output = tempfile.TemporaryFile()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            for index in range(count):
                entry = tarfile.TarInfo('app/dependencies/item-' + str(index))
                entry.type = tarfile.DIRTYPE
                archive.addfile(entry)
            if duplicate:
                entry = tarfile.TarInfo('app/dependencies/item-0')
                entry.type = tarfile.DIRTYPE
                archive.addfile(entry)
            for name in installer.MEMBERS:
                entry = tarfile.TarInfo(name)
                content = b'verified component\n'
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))
        output.seek(0)
        return output

    def test_valid_os_bundle_can_exceed_old_250000_member_limit(self):
        # The actual canonical production bundle reaches this boundary before its
        # protected component, so tiny synthetic archives missed the regression.
        with self.archive(250001) as archive:
            self.assertEqual(set(installer.payload(archive.fileno())), set(installer.MEMBERS))

    def test_unrelated_duplicate_members_are_still_rejected(self):
        with self.archive(8, duplicate=True) as archive:
            with self.assertRaises(installer.ConfigError):
                installer.payload(archive.fileno())

    def test_member_limit_is_still_bounded(self):
        with self.archive(5) as archive, patch.object(installer, 'MAX_MEMBERS', 6):
            with self.assertRaises(installer.ConfigError):
                installer.payload(archive.fileno())

    def test_stream_does_not_retain_unrelated_member_objects(self):
        retained = []
        original = installer.BoundedTarInfo._proc_member

        def observe(entry, archive):
            retained.append(len(archive.members))
            return original(entry, archive)

        with self.archive(50) as archive, patch.object(installer.BoundedTarInfo, '_proc_member', observe):
            installer.payload(archive.fileno())
        self.assertLessEqual(max(retained), 2)


if __name__ == '__main__':
    unittest.main()

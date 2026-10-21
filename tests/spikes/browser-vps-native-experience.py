import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[2] / 'scripts/spikes/browser-vps'
spec = importlib.util.spec_from_file_location('native_experience', source / 'native-experience.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class BoundaryTests(unittest.TestCase):
    def test_private_preview_requires_exact_machine_and_owner(self):
        handle = 'pv-2687-1234abcd'
        machine = '12345678-1234-4123-8123-123456789abc'
        owner = 'user_syntheticOwner'
        env = f'MATRIX_HANDLE={handle}\nMATRIX_RUNTIME_SLOT={handle}\nMATRIX_MACHINE_ID={machine}\nMATRIX_CLERK_USER_ID={owner}\n'
        self.assertEqual(helper.assert_target(env, handle, machine, owner), handle)
        self.assertEqual(helper.assert_target(env + f'MATRIX_USER_ID={owner}\n', handle, machine, owner), handle)
        for args in [
            (env, handle), (env, handle, machine), (env, handle, 'invalid', owner),
            (env, handle, machine, 'user_other'), (env, 'pv-2782-1234abcd', machine, owner),
            (env, 'pv-02687-1234abcd', machine, owner),
            (env.replace(f'MATRIX_RUNTIME_SLOT={handle}', 'MATRIX_RUNTIME_SLOT=primary'), handle, machine, owner),
            (env.replace(machine, '22345678-1234-4123-8123-123456789abc'), handle, machine, owner),
            (env + f'MATRIX_MACHINE_ID={machine}\n', handle, machine, owner),
            (env + f'MATRIX_CLERK_USER_ID={owner}\n', handle, machine, owner),
            (env + 'MATRIX_USER_ID=user_other\n', handle, machine, owner),
            (env + f'MATRIX_USER_ID={owner}\nMATRIX_USER_ID={owner}\n', handle, machine, owner),
        ]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                helper.assert_target(*args)
        with patch.object(helper.os, 'getuid', return_value=0), patch.object(helper, 'read_host_environment', return_value=env):
            helper.main(['guard', handle, machine, owner])

    def test_private_preview_guard_matches_the_node_boundary(self):
        handle = 'pv-2722-3fa91c2e'
        machine = '12345678-1234-4123-8123-123456789abc'
        owner = 'user_syntheticOwner'
        identity = f'MATRIX_MACHINE_ID={machine}\nMATRIX_CLERK_USER_ID={owner}\n'
        env = f'MATRIX_HANDLE={handle}\nMATRIX_RUNTIME_SLOT={handle}\n' + identity
        self.assertEqual(helper.assert_target(env, handle, machine, owner), handle)
        for invalid in ['pv-0-3fa91c2e', 'pv-02722-3fa91c2e', 'pv-2722-3FA91C2E', 'pv-2722-3fa91c2', 'pv-2722-3fa91c2ee', 'pv-2722-../../primary', 'pv-1234567890-3fa91c2e']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                helper.assert_target(f'MATRIX_HANDLE={invalid}\nMATRIX_RUNTIME_SLOT={invalid}\n' + identity, invalid, machine, owner)
        for slot in ['primary', 'pr-2722', 'pv-2722-aaaaaaaa']:
            with self.subTest(slot=slot), self.assertRaises(ValueError):
                helper.assert_target(f'MATRIX_HANDLE={handle}\nMATRIX_RUNTIME_SLOT={slot}\n' + identity, handle, machine, owner)
        with self.assertRaises(ValueError):
            helper.assert_target(env + f'MATRIX_HANDLE={handle}\n', handle, machine, owner)

    def test_guard_accepts_only_exact_single_preview_classification(self):
        env = 'SECRET=synthetic-only\nMATRIX_HANDLE=pr-2526\nMATRIX_RUNTIME_SLOT=pr-2526\n'
        self.assertEqual(helper.assert_target(env, 'pr-2526'), 'pr-2526')
        for invalid in ['primary', 'pr-0', 'pr-2526/../primary', 'pr-02526']:
            with self.assertRaises(ValueError):
                helper.assert_target(env, invalid)
        for invalid in [env + 'MATRIX_HANDLE=pr-2526\n', env.replace('MATRIX_RUNTIME_SLOT=pr-2526', 'MATRIX_RUNTIME_SLOT=primary'), env.replace('MATRIX_HANDLE=pr-2526', 'MATRIX_HANDLE=pr-1')]:
            with self.assertRaises(ValueError):
                helper.assert_target(invalid, 'pr-2526')

    def test_unit_data_has_one_shared_truth_and_rejects_unbounded_or_arbitrary_paths(self):
        files = helper.load_files(source / 'native-experience.json')
        self.assertEqual(files, json.loads((source / 'native-experience.json').read_text()))
        with tempfile.TemporaryDirectory() as parent:
            fixture = Path(parent) / 'bad.json'
            for value in [{'/etc/unrelated': 'bad'}, {**files, 'tint2rc': 'x' * 40000}, {**files, 'tint2rc': []}]:
                fixture.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    helper.load_files(fixture)

    def test_atomic_replace_does_not_follow_target_symlink(self):
        with tempfile.TemporaryDirectory() as parent:
            outside = Path(parent) / 'outside'
            outside.write_text('synthetic preserved')
            target = Path(parent) / 'tint2rc'
            target.symlink_to(outside)
            helper.atomic_write(parent, 'tint2rc', 'replacement', owner_uid=os.getuid())
            self.assertEqual(outside.read_text(), 'synthetic preserved')
            self.assertFalse(target.is_symlink())
            self.assertEqual(target.read_text(), 'replacement')
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
            self.assertEqual(target.stat().st_uid, os.getuid())

    def test_atomic_failure_preserves_original_and_removes_temporary(self):
        with tempfile.TemporaryDirectory() as parent:
            target = Path(parent) / 'tint2rc'
            target.write_text('original')
            with patch.object(helper.os, 'replace', side_effect=OSError('Synthetic replace failure')):
                with self.assertRaises(OSError):
                    helper.atomic_write(parent, 'tint2rc', 'replacement', owner_uid=os.getuid())
            self.assertEqual(target.read_text(), 'original')
            self.assertEqual(sorted(os.listdir(parent)), ['tint2rc'])

    def test_rejects_writable_foreign_and_symlink_directories(self):
        with tempfile.TemporaryDirectory() as parent:
            with self.assertRaises(ValueError):
                helper.atomic_write(parent, 'tint2rc', 'data', owner_uid=os.getuid() + 1)
            os.chmod(parent, 0o777)
            with self.assertRaises(ValueError):
                helper.atomic_write(parent, 'tint2rc', 'data', owner_uid=os.getuid())
            os.chmod(parent, 0o700)
            link = Path(parent) / 'link'
            link.symlink_to(parent)
            with self.assertRaises((OSError, ValueError)):
                helper.atomic_write(link, 'tint2rc', 'data', owner_uid=os.getuid())

    def test_install_guard_runs_before_loading_data_or_mutating(self):
        with patch.object(helper.os, 'getuid', return_value=0), patch.object(helper, 'read_host_environment', return_value='MATRIX_HANDLE=primary\nMATRIX_RUNTIME_SLOT=primary\n'), patch.object(helper, 'load_files') as load, patch.object(helper, 'atomic_write') as write:
            with self.assertRaises(ValueError):
                helper.main(['install', 'pr-2526'])
            load.assert_not_called()
            write.assert_not_called()

    def test_install_writes_only_four_fixed_destinations_and_requires_root(self):
        env = 'MATRIX_HANDLE=pr-2526\nMATRIX_RUNTIME_SLOT=pr-2526\n'
        files = helper.load_files(source / 'native-experience.json')
        with patch.object(helper.os, 'getuid', return_value=0), patch.object(helper, 'read_host_environment', return_value=env), patch.object(helper, 'atomic_write') as write:
            helper.main(['install', 'pr-2526'])
            self.assertEqual(write.call_count, 4)
            for name, content in files.items():
                write.assert_any_call('/opt/matrix-browser-lab' if name == 'tint2rc' else '/etc/systemd/system', name, content)
        with patch.object(helper.os, 'getuid', return_value=1000), patch.object(helper, 'read_host_environment') as read:
            with self.assertRaises(ValueError):
                helper.main(['install', 'pr-2526'])
            read.assert_not_called()


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(BoundaryTests))
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('Native experience boundary checks passed')

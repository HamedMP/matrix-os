"""Portable evidence checks for the disposable root fixture runner."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('root_runner', ROOT / 'scripts/ci/run-funded-host-root-tests.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RootRunnerTests(unittest.TestCase):
    def test_success_with_all_or_partial_skips_is_not_execution_evidence(self):
        for total, skipped in ((0, []), (1, [(None, 'root unavailable')]), (2, [(None, 'root unavailable')])):
            result = unittest.TestResult()
            result.testsRun, result.skipped = total, skipped
            self.assertTrue(result.wasSuccessful())
            with self.assertRaises(RuntimeError):
                runner.execution_counts(result)

    def test_failed_result_is_rejected_and_executed_count_is_explicit(self):
        result = unittest.TestResult()
        result.testsRun = 3
        self.assertEqual(runner.execution_counts(result), {'executed': 3, 'skipped': 0})
        result.failures = [(None, 'synthetic failure')]
        with self.assertRaises(RuntimeError):
            runner.execution_counts(result)

    def test_missing_explicit_disposable_authority_fails_before_loading_fixtures(self):
        with patch.dict(runner.os.environ, {'MATRIX_DISPOSABLE_ROOT_TEST': ''}), self.assertRaises(RuntimeError):
            runner.require_disposable()


if __name__ == '__main__':
    unittest.main()

"""Run fixed root fixtures only inside an explicit disposable Linux container."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SUITES = ('funded-host-component.test.py', 'funded-host-restoration.test.py',
          'funded-host-artifact-repair.test.py', 'funded-host-install-serialization.test.py',
          'funded-host-generated.test.py')


def require_disposable():
    if not (sys.platform == 'linux' and os.geteuid() == 0 and Path('/.dockerenv').is_file()
            and os.environ.get('MATRIX_DISPOSABLE_ROOT_TEST') == 'true'):
        raise RuntimeError('explicit disposable root Linux container required')


def execution_counts(result):
    if not result.wasSuccessful() or result.testsRun <= len(result.skipped) or result.skipped:
        raise RuntimeError('root fixture must execute successfully without skipped cases')
    return {'executed': result.testsRun, 'skipped': len(result.skipped)}


def main():
    require_disposable()
    # Container job also has an independent outer deadline and cleanup trap.
    signal.alarm(120)
    for index, fixture in enumerate(SUITES):
        path = ROOT / 'tests/deploy/customer-vps' / fixture
        spec = importlib.util.spec_from_file_location('root_fixture_' + str(index), path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        suite = unittest.defaultTestLoader.loadTestsFromModule(module)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        counts = execution_counts(result)
        print(json.dumps({'fixture': fixture, **counts}), flush=True)
    signal.alarm(0)


if __name__ == '__main__':
    main()

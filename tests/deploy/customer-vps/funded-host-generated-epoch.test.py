"""Missing-epoch variant of the emitted program's complete lifecycle fixture.

Runs the exact archive/inline/installed entrypoints, including pre-publication
Platform outage, unavailable post-publication inspection, resume, guarded field
rollback and later failed-update recovery. No reimplementation of shipped logic.
"""
import importlib.util
import os
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('shared_generated_fixture', Path(__file__).with_name('funded-host-generated.test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').is_dir(), 'disposable root Linux only')
class GeneratedEpochTests(unittest.TestCase):
    def test_epoch_absent_emitted_program_interrupted_publish_resume_and_rollback(self):
        self.epoch_absent = True
        fixture.GeneratedProgramTests.test_generated_bootstrap_and_program_two_hop_apply_noop_rollback(self)


if __name__ == '__main__':
    unittest.main()

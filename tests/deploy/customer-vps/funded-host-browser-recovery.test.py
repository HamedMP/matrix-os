"""Real Browser writer versus sealed funded recovery; disposable root only."""
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('speech_fixture', Path(__file__).with_name('funded-host-speech-recovery.test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
runtime, installer = fixture.runtime, fixture.installer
browser = fixture.fixture.fixture.load('browser_writer', 'distro/customer-vps/host-bin/matrix-browser-runtime.py')


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').is_dir(), 'disposable root Linux only')
class BrowserRecoveryTests(unittest.TestCase):
    setUp = fixture.SpeechRecoveryTests.setUp
    tearDown = fixture.SpeechRecoveryTests.tearDown
    admission = fixture.SpeechRecoveryTests.admission
    prepare = fixture.SpeechRecoveryTests.prepare
    configure_speech = fixture.SpeechRecoveryTests.configure

    def configure_browser(self):
        writer = browser.Runtime(Path(self.root), uid=0, gid=0)
        writer.prefix.mkdir(exist_ok=True)
        authorization = 'Basic ' + base64.b64encode(('matrix-browser-lab:' + 'a' * 64).encode()).decode()
        (writer.prefix / 'credential-pending.json').write_text(json.dumps({
            'authorization': authorization, 'passwordData': base64.b64encode(b'synthetic-vnc-password').decode()}))
        (writer.prefix / 'credential-pending.json').chmod(0o600)
        writer.credentials()
        writer.enable_environment()

    def test_browser_setup_then_speech_preserves_preflight_and_rollback(self):
        self.check_recovery(speech_first=False)

    def test_speech_then_browser_setup_preserves_preflight_and_rollback(self):
        self.check_recovery(speech_first=True)

    def test_browser_without_speech_and_absent_epoch_preserves_recovery(self):
        self.original = self.original.replace(b'MATRIX_RUNTIME_TOKEN_EPOCH=2\n', b'')
        Path(self.env).write_bytes(self.original)
        self.check_recovery(speech_first=None)

    def check_recovery(self, speech_first):
        self.prepare()
        if speech_first is True:
            self.configure_speech()
        self.configure_browser()
        if speech_first is False:
            self.configure_speech()
        after = Path(self.env).read_bytes()
        self.calls.clear()
        responses = self.responses
        runtime.recovery_proof(True)
        app = Path(self.root + '/opt/matrix/app')
        app.rename(app.with_name('app.rollback'))
        app.mkdir()
        (app / 'BUNDLE_VERSION').write_text('candidate\n')
        runtime.recovery_proof(False)
        self.assertEqual(Path(self.env).read_bytes(), after)
        self.assertEqual({p.name: p.read_bytes() for p in Path(self.env).parent.glob('host.env.funded-*.json')}, self.journals)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.responses, responses)

    def test_rejects_unrelated_and_malformed_browser_drift(self):
        self.prepare()
        self.configure_browser()
        good = Path(self.env).read_bytes()
        for changed in (good + b'UNTRUSTED=1\n', good.replace(b'# preserve owner config', b'# changed'),
                        good + b'MATRIX_BROWSER_LAB=true\n',
                        good.replace(b'MATRIX_BROWSER_LAB=true', b'export MATRIX_BROWSER_LAB=true'),
                        good.replace(b'MATRIX_BROWSER_LAB=true', b'MATRIX_BROWSER_LAB=$(id)'),
                        good.replace(b'MATRIX_BROWSER_LAB_VIEWER_AUTH=', b'export MATRIX_BROWSER_LAB_VIEWER_AUTH='),
                        good + b'MATRIX_BROWSER_LAB_VIEWER_AUTH="Basic invalid"\n',
                        good.replace(b'MATRIX_BROWSER_LAB_VIEWER_AUTH="Basic ', b'MATRIX_BROWSER_LAB_VIEWER_AUTH="Bearer '),
                        good.replace(b'MATRIX_FUNDED_AI_ENABLED=true', b'MATRIX_FUNDED_AI_ENABLED=false')):
            Path(self.env).write_bytes(changed)
            with self.assertRaises(Exception):
                runtime.recovery_proof(True)
            self.assertEqual(Path(self.env).read_bytes(), changed)

    def test_browser_opt_out_remains_disabled(self):
        self.prepare()
        self.configure_browser()
        disabled = Path(self.env).read_bytes().replace(b'MATRIX_BROWSER_LAB=true', b'MATRIX_BROWSER_LAB=false')
        Path(self.env).write_bytes(disabled)
        runtime.recovery_proof(True)
        self.assertEqual(Path(self.env).read_bytes(), disabled)

    def test_speech_does_not_require_a_disabled_browser_to_have_credentials(self):
        Path(self.env).write_bytes(self.original + b'MATRIX_BROWSER_LAB=false\n')
        self.prepare()
        self.configure_speech()
        runtime.recovery_proof(True)


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').is_dir(), 'disposable root Linux only')
class BrowserResealTests(unittest.TestCase):
    tearDown = BrowserRecoveryTests.tearDown
    admission = BrowserRecoveryTests.admission
    configure_speech = BrowserRecoveryTests.configure_speech
    configure_browser = BrowserRecoveryTests.configure_browser
    prepare = fixture.SpeechResealTests.prepare
    refresh_guard = fixture.SpeechResealTests.refresh_guard
    check_interrupted_commit = fixture.SpeechResealTests.check_interrupted_commit

    def setUp(self):
        BrowserRecoveryTests.setUp(self)
        run = Path(self.root + '/run')
        run.mkdir()
        (run / 'matrix-browser-runtime.lock').touch(mode=0o600)
        original_open = os.open
        def rooted_open(path, *args, **kwargs):
            return original_open(self.root + path if path == '/run/matrix-browser-runtime.lock' else path, *args, **kwargs)
        p = patch.object(os, 'open', rooted_open)
        p.start()
        self.patches.append(p)

    def configure(self):
        self.configure_speech()
        self.configure_browser()

    def test_reseal_preserves_browser_pair_and_original_funded_rollback(self):
        self.prepare()
        before = Path(self.env).read_bytes()
        runtime.recovery_proof(reseal=self.request)
        self.assertEqual(Path(self.env).read_bytes(), before)
        runtime.recovery_proof(reseal=self.request, commit=True)
        after = Path(self.env).read_bytes()
        self.assertEqual(runtime.browser_values(after), runtime.browser_values(before))
        journal_path = next(Path(self.env).parent.glob('host.env.funded-*.json'))
        journal = json.loads(journal_path.read_bytes())
        self.assertEqual(json.loads(self.applied_path.read_bytes())['afterSha256'], hashlib.sha256(after).hexdigest())
        repair = fixture.fixture.fixture.load('browser_resealed_repair', 'scripts/ops/repair-funded-chat-config.py')
        _, values, _ = repair.parse(after)
        directory = os.open(journal_path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            original = repair.rollback_image(directory, journal_path.name, after, values,
                json.loads(self.applied_path.read_bytes())['identity'], 0, 0, Path(self.env).stat())
        finally:
            os.close(directory)
        self.assertEqual(runtime.browser_values(original), runtime.browser_values(before))
        self.assertNotIn(b'MATRIX_FUNDED_AI_ENABLED=', original)
        self.refresh_guard()
        runtime.recovery_proof(reseal=self.request, commit=True)

    def test_resumes_each_partial_commit_without_discarding_other_changes(self):
        for failure in ('journal', 'host.env', 'applied.json', 'speech-reseal-receipt.json'):
            with self.subTest(failure=failure):
                # A fresh fixture per operation keeps independent funded histories.
                if failure != 'journal':
                    self.tearDown()
                    self.setUp()
                self.check_interrupted_commit(failure)

    def test_rejects_stale_guard_and_busy_browser_writer(self):
        self.prepare()
        descriptor = os.open(self.root + '/run/matrix-browser-runtime.lock', os.O_RDONLY)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                runtime.recovery_proof(reseal=self.request, commit=True)
        finally:
            os.close(descriptor)
        self.request['expectedFile']['sha256'] = 'f' * 64
        with self.assertRaises(Exception):
            runtime.recovery_proof(reseal=self.request, commit=True)
        self.assertEqual(self.applied_path.read_bytes(), self.before_applied)

    def test_absent_epoch_migration_retains_epoch_absence_in_rollback(self):
        self.original = self.original.replace(b'MATRIX_RUNTIME_TOKEN_EPOCH=2\n', b'')
        Path(self.env).write_bytes(self.original)
        self.prepare()
        runtime.recovery_proof(reseal=self.request, commit=True)
        journal_path = next(Path(self.env).parent.glob('host.env.funded-*.json'))
        original = base64.b64decode(json.loads(journal_path.read_bytes())['original'], validate=True)
        self.assertNotIn(b'MATRIX_RUNTIME_TOKEN_EPOCH=', original)
        self.assertIn(b'MATRIX_BROWSER_LAB_VIEWER_AUTH=', original)


if __name__ == '__main__':
    unittest.main()

"""Bounded service restoration regressions; disposable root Linux only."""
import importlib.util
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('component_fixture', Path(__file__).with_name('funded-host-component.test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
runtime, installer = fixture.runtime, fixture.installer


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').is_dir(), 'disposable root Linux only')
class RestorationTests(unittest.TestCase):
    setUp = fixture.RootLifecycleTests.setUp
    tearDown = fixture.RootLifecycleTests.tearDown
    admission = fixture.RootLifecycleTests.admission

    def prepare_resume(self):
        installer.install(fixture.VERSION, fixture.SHA)
        state = runtime.Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
        receipt = runtime.json_bytes(state.read('receipt.json'))
        state.write('resume.json', json.dumps(runtime.resume_record(state, [s for s in runtime.SERVICES if self.states[s] == 'active'], receipt)).encode(), 0o600)
        state.close()
        for name in self.states:
            self.states[name] = 'inactive'
        return Path(self.root + '/var/lib/matrix-funded-host-config/resume.json')

    def test_failed_apply_unknown_cleanup_retains_full_intent_across_partial_resumes(self):
        installer.install(fixture.VERSION, fixture.SHA)
        self.admission()
        run = runtime.run
        failed = [False]
        def fault(action='apply', attempt=None):
            if action == 'apply':
                result = run(action, attempt)
                failed[0] = True
                raise installer.ConfigError('injected apply failure')
            if action == 'inspect' and failed[0]:
                raise installer.ConfigError('inspection unavailable')
            return run(action, attempt)
        with patch.object(runtime, 'run', fault), self.assertRaises(installer.ConfigError):
            runtime.maintenance()
        marker = Path(self.root + '/var/lib/matrix-funded-host-config/resume.json')
        self.assertTrue(marker.exists(), 'partial Sync recovery must retain original intent')
        saved = marker.read_bytes()
        prior = json.loads(saved)
        self.assertEqual(prior['services'], [s for s in runtime.SERVICES if s != 'matrix-symphony.service'])
        self.assertEqual(prior['beforeSha256'], installer.digest(self.original))
        receipt = marker.with_name('receipt.json').read_bytes()
        self.assertEqual(prior['receiptSha256'], installer.digest(receipt))
        applied = marker.with_name('applied.json').read_bytes()
        journals = {str(p): p.read_bytes() for p in Path(self.env).parent.glob('host.env.funded-*.json')}
        self.assertTrue(journals)
        self.assertEqual(self.states['matrix-sync-agent.service'], 'active')
        self.assertTrue(all(self.states[s] == 'inactive' for s in prior['services'][:-1]))
        fd_count = len(os.listdir('/proc/self/fd'))
        for _ in range(60):
            self.calls.clear()
            with self.assertRaises(installer.ConfigError):
                runtime.resume()
            self.assertEqual(marker.read_bytes(), saved)
            self.assertTrue(all(c[-1] == 'matrix-sync-agent.service' for c in self.calls if c[0] == 'start'))
        self.assertEqual(len(os.listdir('/proc/self/fd')), fd_count)
        with self.assertRaises(installer.ConfigError):
            installer.install('v-next-repair', fixture.SHA)
        # Independently restored exact prior bytes are safe even with Sync active.
        Path(self.env).write_bytes(self.original)
        runtime.resume()
        self.assertFalse(marker.exists())
        self.assertTrue(all(self.states[s] == 'active' for s in prior['services']))
        self.assertEqual(marker.with_name('receipt.json').read_bytes(), receipt)
        self.assertEqual(marker.with_name('applied.json').read_bytes(), applied)
        self.assertEqual({str(p): p.read_bytes() for p in Path(self.env).parent.glob('host.env.funded-*.json')}, journals)

    def test_prewrite_barrier_survives_interrupted_apply_without_unsafe_restart(self):
        installer.install(fixture.VERSION, fixture.SHA)
        self.admission()
        marker = Path(self.root + '/var/lib/matrix-funded-host-config/resume.json')
        run = runtime.run
        evidence = []
        def interrupted(action='apply', attempt=None):
            if action == 'apply':
                prior = json.loads(marker.read_bytes())
                self.assertEqual(prior.get('beforeSha256'), installer.digest(self.original))
                self.assertEqual(prior.get('safeEnvSha256'), installer.digest(self.original))
                evidence.append(marker.read_bytes())
                run(action, attempt)
                raise KeyboardInterrupt('simulated interruption after field replacement')
            return run(action, attempt)
        with patch.object(runtime, 'run', interrupted), self.assertRaises(installer.ConfigError):
            runtime.maintenance()
        self.assertEqual(marker.read_bytes(), evidence[0])
        self.assertEqual(self.states['matrix-gateway.service'], 'inactive')
        with self.assertRaises(installer.ConfigError):
            runtime.resume()
        self.assertEqual(marker.read_bytes(), evidence[0])
        Path(self.env).write_bytes(self.original)
        runtime.resume()
        self.assertFalse(marker.exists())

    def test_initial_proof_failure_refuses_before_stop_and_receipt_changes(self):
        installer.install(fixture.VERSION, fixture.SHA)
        self.admission()
        state = Path(self.root + '/var/lib/matrix-funded-host-config')
        receipt = (state / 'receipt.json').read_bytes()
        lock = Path(self.env).parent / '.host.env.funded-repair.lock'
        lock.touch(mode=0o600)
        with lock.open('rb') as fd:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                runtime.maintenance()
        self.assertFalse((state / 'resume.json').exists())
        self.assertEqual((state / 'receipt.json').read_bytes(), receipt)
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertFalse(any(c[0] in ('stop', 'start') for c in self.calls))

    def test_interrupted_field_rollback_retains_initial_applied_baseline(self):
        installer.install(fixture.VERSION, fixture.SHA)
        self.admission()
        runtime.maintenance()
        before = Path(self.env).read_bytes()
        self.admission()
        # The fixture's prior-version deployment admission mirrors the existing lifecycle.
        state = runtime.Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
        receipt = runtime.json_bytes(state.read('receipt.json'))
        state.write('previous-receipt.json', json.dumps(dict(receipt, version='v-prior-repair')).encode(), 0o600)
        invocation = runtime.json_bytes(state.read('invocation.json'))
        invocation['operation'] = 'rollback'
        invocation['priorVersion'] = 'v-prior-repair'
        state.write('invocation.json', json.dumps(invocation).encode(), 0o600)
        state.close()
        run = runtime.run
        marker = Path(self.root + '/var/lib/matrix-funded-host-config/resume.json')
        evidence = []
        def interrupted(action='apply', attempt=None):
            if action == 'rollback':
                evidence.append(marker.read_bytes())
                self.assertEqual(json.loads(evidence[0])['beforeSha256'], installer.digest(before))
                run(action, attempt)
                raise KeyboardInterrupt('interrupted field rollback')
            return run(action, attempt)
        with patch.object(runtime, 'run', interrupted), self.assertRaises(installer.ConfigError):
            runtime.maintenance()
        self.assertEqual(marker.read_bytes(), evidence[0])
        self.assertEqual(self.states['matrix-gateway.service'], 'inactive')
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        with self.assertRaises(installer.ConfigError):
            runtime.resume()
        self.assertEqual(marker.read_bytes(), evidence[0])

    def test_unknown_or_corrupt_safety_evidence_cannot_restore_runtime(self):
        for fault in ('legacy', 'bad-hash', 'receipt', 'bundle', 'code', 'env-lock'):
            with self.subTest(fault=fault):
                marker = self.prepare_resume()
                prior = json.loads(marker.read_bytes())
                code = Path(self.root + '/usr/local/libexec/matrix-funded-host-config.py')
                bundle = Path(self.root + '/opt/matrix/app/BUNDLE_VERSION')
                code_bytes, bundle_bytes = code.read_bytes(), bundle.read_bytes()
                if fault == 'legacy':
                    prior = {k: prior[k] for k in ('services', 'version', 'sourceSha')}
                if fault == 'bad-hash':
                    prior['safeEnvSha256'] = 'unknown'
                if fault == 'receipt':
                    prior['receiptSha256'] = '0' * 64
                if fault == 'bundle':
                    bundle.write_text('v-other')
                if fault == 'code':
                    code.write_bytes(b'changed protected code')
                marker.write_text(json.dumps(prior))
                saved = marker.read_bytes()
                self.calls.clear()
                lock = Path(self.env).parent / '.host.env.funded-repair.lock'
                lock.touch(mode=0o600)
                with lock.open('rb') as fd:
                    if fault == 'env-lock':
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with self.assertRaises((installer.ConfigError, BlockingIOError)):
                        runtime.resume()
                self.assertEqual(marker.read_bytes(), saved)
                self.assertFalse(any(c[0] == 'start' and c[-1] != 'matrix-sync-agent.service' for c in self.calls))
                self.assertEqual(Path(self.env).read_bytes(), self.original)
                code.write_bytes(code_bytes)
                bundle.write_bytes(bundle_bytes)
                marker.unlink()

    def test_delayed_start_is_queued_verified_and_sync_is_last(self):
        marker = self.prepare_resume()
        pending, clock, events = {}, [0], []
        for service in runtime.SERVICES:
            if service != 'matrix-symphony.service':
                self.states[service] = 'deactivating'
        def sleep(seconds):
            clock[0] += seconds
        def ctl(*args):
            events.append(args)
            service = args[-1]
            if args[0] == 'start':
                self.assertGreaterEqual(clock[0], 90)
                # Gateway waits up to720s for Terminal, then itself permits720s.
                if '--no-block' not in args:
                    raise subprocess.TimeoutExpired('systemctl', 10)
                if service == 'matrix-sync-agent.service':
                    self.assertTrue(all(self.states[s] == 'active' for s in runtime.SERVICES[:-1]
                                        if s != 'matrix-symphony.service'))
                pending[service] = clock[0] + (1440 if service == 'matrix-gateway.service' else 15)
                self.states[service] = 'activating'
                return 0, ''
            if args[0] == 'is-active':
                if self.states[service] == 'deactivating' and clock[0] >= 90:
                    self.states[service] = 'inactive'
                if service in pending and clock[0] >= pending[service]:
                    self.states[service] = 'active'
                return 0, self.states[service]
            self.fail('unexpected service action')
        with patch.object(runtime, 'systemctl', ctl), patch.object(runtime.time, 'monotonic', lambda: clock[0]), \
             patch.object(runtime.time, 'sleep', sleep):
            runtime.resume()
        self.assertGreater(clock[0], 1530)
        self.assertLess(clock[0], runtime.RESTORE_TIMEOUT)
        self.assertFalse(marker.exists())
        starts = [event[-1] for event in events if event[0] == 'start']
        self.assertEqual(starts[-1], 'matrix-sync-agent.service')
        self.assertEqual(self.states['matrix-symphony.service'], 'inactive')

    def test_start_or_verification_failure_retains_evidence_for_stop_post(self):
        for fault in ('start', 'failed', 'never-active'):
            with self.subTest(fault=fault):
                marker = self.prepare_resume()
                saved, clock = marker.read_bytes(), [0]
                def ctl(*args):
                    service = args[-1]
                    if args[0] == 'start':
                        if service == 'matrix-gateway.service' and fault == 'start':
                            return 1, ''
                        self.states[service] = 'active'
                        return 0, ''
                    if service == 'matrix-gateway.service':
                        return 1, 'failed' if fault == 'failed' else 'activating'
                    return 0, self.states[service]
                def sleep(seconds):
                    clock[0] += seconds
                with patch.object(runtime, 'systemctl', ctl), patch.object(runtime.time, 'monotonic', lambda: clock[0]), \
                     patch.object(runtime.time, 'sleep', sleep), self.assertRaises(installer.ConfigError):
                    runtime.resume()
                self.assertEqual(marker.read_bytes(), saved)
                self.assertEqual(self.states['matrix-sync-agent.service'], 'inactive')
                # ExecStopPost repeats the protected resume using retained evidence.
                runtime.resume()
                self.assertFalse(marker.exists())
                self.assertEqual(self.states['matrix-sync-agent.service'], 'active')

    def test_delayed_stops_finish_before_configuration_and_restore_sync_last(self):
        installer.install(fixture.VERSION, fixture.SHA)
        self.admission()
        clock, pending = [0], {}
        ctl, run = runtime.systemctl, runtime.run
        def control(*args):
            service = args[-1]
            if args[0] == 'stop':
                self.calls.append(args)
                if '--no-block' not in args:
                    self.states[service] = 'deactivating'
                    raise subprocess.TimeoutExpired('systemctl', 10)
                delay = 30 if service == 'matrix-terminal-runtime.service' else 45 if service == 'matrix-scope-runtime.service' else 90
                pending[service] = clock[0] + delay
                self.states[service] = 'deactivating'
                return 0, ''
            if args[0] == 'is-active' and service in pending and clock[0] >= pending[service]:
                self.states[service] = 'inactive'
                del pending[service]
            if args[0] == 'start':
                self.assertFalse(pending)
                if service == 'matrix-sync-agent.service':
                    self.assertTrue(all(self.states[s] == 'active' for s in runtime.SERVICES[:-1]
                                        if s != 'matrix-symphony.service'))
            return ctl(*args)
        def guarded_run(action='apply', attempt=None):
            if action != 'admit':
                self.assertGreaterEqual(clock[0], 90)
                self.assertFalse(pending)
            return run(action, attempt)
        with patch.object(runtime, 'systemctl', control), patch.object(runtime, 'run', guarded_run), \
             patch.object(runtime.time, 'monotonic', lambda: clock[0]), \
             patch.object(runtime.time, 'sleep', lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            runtime.maintenance()
        self.assertIn(b'MATRIX_FUNDED_AI_ENABLED=true', Path(self.env).read_bytes())
        self.assertFalse(Path(self.root + '/var/lib/matrix-funded-host-config/resume.json').exists())
        self.assertEqual([call[-1] for call in self.calls if call[0] == 'start'][-1], 'matrix-sync-agent.service')

    def test_failed_or_unfinished_stop_retains_evidence_without_config_write(self):
        installer.install(fixture.VERSION, fixture.SHA)
        for fault in ('never-stopped', 'queue-failure'):
            with self.subTest(fault=fault):
                for service in self.states:
                    self.states[service] = 'active' if service != 'matrix-symphony.service' else 'inactive'
                self.admission()
                self.calls.clear()
                clock = [0]
                ctl = runtime.systemctl
                def control(*args):
                    service = args[-1]
                    if args[0] == 'stop':
                        self.calls.append(args)
                        if fault == 'queue-failure' and service == 'matrix-shell.service':
                            return 1, ''
                        self.states[service] = 'deactivating'
                        return 0, ''
                    if args[0] == 'start':
                        self.fail('unfinished stops must settle before restoration starts')
                    return ctl(*args)
                with patch.object(runtime, 'systemctl', control), patch.object(runtime.time, 'monotonic', lambda: clock[0]), \
                     patch.object(runtime.time, 'sleep', lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
                     self.assertRaises(installer.ConfigError):
                    runtime.maintenance()
                marker = Path(self.root + '/var/lib/matrix-funded-host-config/resume.json')
                saved = marker.read_bytes()
                self.assertGreaterEqual(clock[0], 1600)
                self.assertEqual(Path(self.env).read_bytes(), self.original)
                self.assertFalse(marker.with_name('applied.json').exists())
                self.assertEqual(list(Path(self.env).parent.glob('host.env.funded-*.json')), [])
                for service in self.states:
                    self.states[service] = 'inactive'
                runtime.resume()
                self.assertFalse(marker.exists())
                self.assertIn('matrix-gateway.service', json.loads(saved)['services'])

    def test_interrupted_stop_waits_for_deactivation_before_restart(self):
        marker = self.prepare_resume()
        clock, waiting, events = [0], {}, []
        for service in runtime.SERVICES[:-1]:
            if service != 'matrix-symphony.service':
                self.states[service] = 'deactivating'
                waiting[service] = 45
        ctl = runtime.systemctl
        def control(*args):
            events.append(args)
            service = args[-1]
            if args[0] == 'is-active' and service in waiting and clock[0] >= waiting[service]:
                self.states[service] = 'inactive'
                del waiting[service]
            if args[0] == 'start':
                self.assertFalse(waiting)
                self.assertGreaterEqual(clock[0], 45)
            return ctl(*args)
        with patch.object(runtime, 'systemctl', control), patch.object(runtime.time, 'monotonic', lambda: clock[0]), \
             patch.object(runtime.time, 'sleep', lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            runtime.resume()
        self.assertFalse(marker.exists())
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertEqual([call[-1] for call in events if call[0] == 'start'][-1], 'matrix-sync-agent.service')

    def test_loaded_inactive_gateway_dependencies_defer_before_any_stop(self):
        installer.install(fixture.VERSION, fixture.SHA)
        receipt = Path(self.root + '/var/lib/matrix-funded-host-config/receipt.json')
        before = receipt.read_bytes()
        for dependency in ('matrix-terminal-runtime.service', 'matrix-scope-runtime.service'):
            for active in ('inactive', 'failed'):
                with self.subTest(dependency=dependency, state=active):
                    self.states[dependency] = active
                    self.admission()
                    self.calls.clear()
                    with self.assertRaises(installer.ConfigError):
                        runtime.maintenance()
                    self.assertFalse(any(call[0] in ('start', 'stop') for call in self.calls))
                    self.assertEqual(Path(self.env).read_bytes(), self.original)
                    self.assertEqual(receipt.read_bytes(), before)
                    self.assertFalse(Path(self.root + '/var/lib/matrix-funded-host-config/resume.json').exists())
                    self.assertEqual(list(Path(self.env).parent.glob('host.env.funded-*.json')), [])
                    self.states[dependency] = 'active'

    def test_absent_optional_dependencies_remain_absent(self):
        installer.install(fixture.VERSION, fixture.SHA)
        self.admission()
        ctl = runtime.systemctl
        for service in runtime.GATEWAY_DEPENDENCIES:
            self.states[service] = 'inactive'
        def absent(*args):
            if args[0] == 'show' and 'LoadState' in args[1] and args[-1] in runtime.GATEWAY_DEPENDENCIES:
                self.calls.append(args)
                return 0, 'not-found'
            return ctl(*args)
        with patch.object(runtime, 'systemctl', absent):
            runtime.maintenance()
        for service in runtime.GATEWAY_DEPENDENCIES:
            self.assertEqual(self.states[service], 'inactive')
            self.assertFalse(any(call[0] in ('stop', 'start') and call[-1] == service for call in self.calls))

    def test_resume_lock_and_unknown_legacy_intent_preserve_protected_state(self):
        marker = self.prepare_resume()
        lock_path = marker.with_name('resume.lock')
        lock_path.touch(mode=0o600)
        before = marker.read_bytes()
        with lock_path.open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                runtime.resume()
        self.assertEqual(marker.read_bytes(), before)
        self.assertFalse(any(call[0] in ('stop', 'start') for call in self.calls))
        state = runtime.Directory('/', ('var', 'lib', 'matrix-funded-host-config'))
        state.write('resume.json', json.dumps({'services': ['matrix-sync-agent.service'],
                    'version': fixture.VERSION, 'sourceSha': fixture.SHA}).encode(), 0o600)
        state.close()
        saved = marker.read_bytes()
        with self.assertRaises(installer.ConfigError):
            runtime.resume()
        self.assertEqual(marker.read_bytes(), saved)
        self.assertTrue(all(self.states[s] == 'inactive' for s in runtime.SERVICES))

    def test_later_maintenance_cannot_overwrite_failed_restoration_evidence(self):
        marker = self.prepare_resume()
        saved = marker.read_bytes()
        for service in self.states:
            self.states[service] = 'active' if service != 'matrix-symphony.service' else 'inactive'
        self.states['matrix-shell.service'] = 'inactive'
        self.admission()
        with self.assertRaises(installer.ConfigError):
            runtime.maintenance()
        self.assertEqual(marker.read_bytes(), saved)
        self.assertEqual(Path(self.env).read_bytes(), self.original)
        self.assertFalse(any(call[0] in ('stop', 'start') for call in self.calls))
        runtime.resume()
        self.assertFalse(marker.exists())
        self.assertEqual(self.states['matrix-shell.service'], 'active')


if __name__ == '__main__':
    unittest.main()

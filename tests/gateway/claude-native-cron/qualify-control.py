#!/usr/bin/env python3
"""Offline Linux 2.1.317 native control qualification; requires loopback-only isolation."""
import argparse
import hashlib
import http.server
import json
import os
import pathlib
import platform
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

ARTIFACTS = {
    "aarch64": "563a0d60ad0c223d9415768210997acb0f7134ea51dc3c238e88bc2e18ddeefa",
    "x86_64": "eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0",
}
MARKER = "QUALIFIED_PHASE_B"
BLOCKED = ("UserPromptSubmit operation blocked by hook:\n"
           "The SDK host reconnected before its prompt hook answered, "
           "so this prompt was not submitted. Send it again.")
MCP = '''import json,os,sys
with open(os.environ['CRON_AUDIT'],'a') as f:
 f.write(json.dumps({'pid':os.getpid(),'phase':os.environ['CRON_PHASE']})+'\\n')
for line in sys.stdin:
 if len(line)>1048576: raise SystemExit(1)
 d=json.loads(line)
 if 'id' not in d: continue
 result=({'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'phase-probe','version':os.environ['CRON_PHASE']}}
  if d.get('method')=='initialize' else {'tools':[]} if d.get('method')=='tools/list' else {})
 print(json.dumps({'jsonrpc':'2.0','id':d['id'],'result':result}),flush=True)
'''


def require(value, label):
    if not value:
        raise AssertionError(label)


def alive(pid):
    return pathlib.Path('/proc', str(pid)).exists()


def main(args):
    report = {'scenario': args.scenario, 'qualified': False, 'real_account_used': False}
    root = native = server = thread = None
    child_rows = []
    try:
        require(sys.platform == 'linux' and os.getuid() != 0, 'isolated_nonroot_linux_required')
        require(sorted(x.name for x in pathlib.Path('/sys/class/net').iterdir()) == ['lo'], 'loopback_only_required')
        require(len(pathlib.Path('/proc/net/route').read_text().strip().splitlines()) == 1, 'external_routes_present')
        status = pathlib.Path('/proc/self/status').read_text()
        require('NoNewPrivs:\t1' in status, 'no_new_privileges_required')
        require(int(next(x.split()[1] for x in status.splitlines() if x.startswith('CapEff:')), 16) == 0, 'capabilities_must_be_zero')
        executable = pathlib.Path(args.native_executable).resolve(strict=True)
        require(executable.is_file() and not executable.is_symlink(), 'regular_native_required')
        with executable.open('rb') as artifact:
            digest = hashlib.file_digest(artifact, 'sha256').hexdigest()
        require(digest == ARTIFACTS.get(platform.machine()), 'unqualified_native_hash')
        report.update(native_version='2.1.317', native_sha256=digest, architecture=platform.machine())
        root = pathlib.Path(tempfile.mkdtemp(prefix='matrix-native-control-'))
        os.chmod(root, 0o700)
        for name in ['home', 'config', 'cwd']:
            (root / name).mkdir(mode=0o700)
        audit = root / 'audit.jsonl'
        audit.touch(mode=0o600, exist_ok=False)
        mcp = root / 'mcp.py'
        mcp.write_text(MCP)
        state = {'api': [], 'error': None, 'ack': False, 'released': False, 'release_count': 0}
        lock = threading.Lock()

        class API(http.server.BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(3)

            def log_message(self, *_args):
                pass

            def do_HEAD(self):
                self.send_response(200)
                self.end_headers()

            def do_POST(self):
                try:
                    size = int(self.headers.get('Content-Length', '-1'))
                    require(0 <= size <= 2 * 1024 * 1024, 'api_body_limit')
                    require(len(self.rfile.read(size)) == size, 'api_truncated_body')
                    path = urlsplit(self.path).path
                    if path == '/v1/messages/count_tokens':
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(b'{"input_tokens":1}')
                        return
                    require(path == '/v1/messages', 'unexpected_api_path')
                    with lock:
                        require(len(state['api']) < 8, 'api_call_limit')
                        state['api'].append((state['ack'], state['released']))
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.end_headers()
                    frames = [
                        ('message_start', {'type': 'message_start', 'message': {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant', 'model': 'claude-haiku-4-5-20251001', 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}}),
                        ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                        ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': MARKER}}),
                        ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                        ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}),
                        ('message_stop', {'type': 'message_stop'}),
                    ]
                    for kind, payload in frames:
                        self.wfile.write(('event: ' + kind + '\ndata: ' + json.dumps(payload) + '\n\n').encode())
                    self.wfile.flush()
                except Exception as error:
                    state['error'] = str(error) if isinstance(error, AssertionError) else type(error).__name__
                    self.close_connection = True

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), API)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = {'HOME': str(root / 'home'), 'CLAUDE_CONFIG_DIR': str(root / 'config'), 'TMPDIR': str(root),
               'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'USER': 'nobody', 'SHELL': '/bin/sh',
               'ANTHROPIC_API_KEY': 'synthetic-local-only', 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}',
               'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_TELEMETRY': '1',
               'DISABLE_ERROR_REPORTING': '1', 'DISABLE_AUTOUPDATER': '1'}
        version = subprocess.run([str(executable), '--version'], cwd=root / 'cwd', env=env,
                                 capture_output=True, timeout=10, check=True)
        require(version.stdout.strip() == b'2.1.317 (Claude Code)' and not version.stderr, 'native_version_mismatch')
        command = [str(executable), '--setting-sources', '', '--strict-mcp-config', '--no-chrome',
                   '--model', 'claude-haiku-4-5-20251001', '--permission-mode', 'default',
                   '--tools', 'ToolSearch,CronCreate,CronList,CronDelete', '--print', '--output-format',
                   'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']
        native = subprocess.Popen(command, cwd=root / 'cwd', env=env, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(native.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(native.stderr, selectors.EVENT_READ, 'stderr')
        buffer = b''
        total = stderr_size = 0
        acks = set()
        results = []
        assistant = []
        pending = None
        prompt_count = 0
        ready_at = None
        deadline = time.monotonic() + 40

        def send(frame):
            data = (json.dumps(frame) + '\n').encode()
            require(len(data) < 16384, 'control_write_limit')
            native.stdin.write(data)
            native.stdin.flush()

        def initialize(identity, callback):
            send({'type': 'control_request', 'request_id': identity, 'request': {'subtype': 'initialize',
                  'hooks': {'UserPromptSubmit': [{'hookCallbackIds': [callback], 'timeout': 15}]}}})

        def replace(identity, phase):
            send({'type': 'control_request', 'request_id': identity, 'request': {'subtype': 'mcp_set_servers',
                  'servers': {'phase-probe': {'command': sys.executable, 'args': ['-u', str(mcp)],
                  'env': {'CRON_PHASE': phase, 'CRON_AUDIT': str(audit)}}}}})

        def audit_rows():
            require(audit.is_file() and not audit.is_symlink() and audit.stat().st_size < 8192, 'audit_limit')
            rows = [json.loads(x) for x in audit.read_text().splitlines()]
            require(len(rows) <= 2, 'unexpected_mcp_child')
            return rows

        initialize('initA', 'promptA')
        while time.monotonic() < deadline:
            require(native.poll() is None, 'native_early_exit')
            for key, _ in selector.select(0.1):
                data = os.read(key.fd, 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                if key.data == 'stderr':
                    stderr_size += len(data)
                    require(stderr_size <= 262144, 'stderr_limit')
                    continue
                total += len(data)
                buffer += data
                require(total <= 8 * 1024 * 1024 and len(buffer) <= 1048576, 'stdout_limit')
                while b'\n' in buffer:
                    raw, buffer = buffer.split(b'\n', 1)
                    frame = json.loads(raw)
                    observed = report.setdefault('observed', [])
                    require(len(observed) < 64, 'frame_observation_limit')
                    observation = {'type': frame.get('type')}
                    if frame.get('type') == 'control_response': observation['id'] = frame.get('response', {}).get('request_id'); observation['subtype'] = frame.get('response', {}).get('subtype')
                    if frame.get('type') == 'result': observation['text'] = frame.get('result', '')[:300]; observation['is_error'] = frame.get('is_error')
                    observed.append(observation)
                    if frame.get('type') == 'control_request':
                        request = frame.get('request', {})
                        require(request.get('subtype') == 'hook_callback' and request.get('callback_id') == 'promptA' and pending is None, 'unexpected_hook')
                        pending = frame['request_id']
                        require(not state['api'], 'inference_before_hook')
                        if args.scenario == 'direct-mcp':
                            replace('mcpB', 'phaseB')
                        else:
                            initialize('initB', 'promptB')
                    elif frame.get('type') == 'control_response':
                        response = frame['response']
                        identity = response['request_id']
                        require(identity in ['initA', 'initB', 'mcpA', 'mcpB'] and identity not in acks, 'unexpected_ack')
                        require(response.get('subtype') == 'success', 'negative_control_ack')
                        acks.add(identity)
                        payload = response.get('response', {})
                        if identity.startswith('init'):
                            require(payload.get('hooks_applied') is True, 'hooks_not_applied')
                            replace('mcpA' if identity == 'initA' else 'mcpB', 'phaseA' if identity == 'initA' else 'phaseB')
                        else:
                            require(payload.get('errors') == {} and payload.get('added') == ['phase-probe'], 'mcp_ack_mismatch')
                            if identity == 'mcpA':
                                prompt_count += 1
                                send({'type': 'user', 'session_id': '', 'message': {'role': 'user', 'content': 'Offline protocol fixture; reply with the supplied synthetic response.'}, 'parent_tool_use_id': None})
                            else:
                                child_rows = audit_rows()
                                require([x['phase'] for x in child_rows] == ['phaseA', 'phaseB'], 'mcp_phases_missing')
                                require(not alive(child_rows[0]['pid']) and alive(child_rows[1]['pid']), 'mcp_liveness_before_release')
                                require(pending is not None and not state['api'], 'replacement_not_held')
                                state['ack'] = state['released'] = True
                                state['release_count'] += 1
                                send({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': pending, 'response': {}}})
                    elif frame.get('type') == 'assistant':
                        assistant.extend(x.get('text', '') for x in frame.get('message', {}).get('content', []) if x.get('type') == 'text')
                    elif frame.get('type') == 'result':
                        results.append((frame.get('is_error'), frame.get('result')))
            require(state['error'] is None, 'synthetic_api_error:' + str(state['error']))
            if state['released'] and results:
                ready_at = ready_at or time.monotonic()
                if time.monotonic() - ready_at >= 1:
                    break
        else:
            raise AssertionError('scenario_deadline')
        native.stdin.close()
        native.wait(timeout=8)
        require(native.returncode == 0, 'native_nonzero_exit')
        require(prompt_count == 1 and state['release_count'] == 1, 'prompt_replayed')
        require(len(results) == 1 and results[0][0] is False, 'native_result_mismatch')
        if args.scenario == 'direct-mcp':
            require(state['api'] == [(True, True)] and ''.join(assistant) == MARKER and results[0][1] == MARKER, 'direct_verdict')
        else:
            require('initB' in acks and not state['api'] and not assistant and results[0][1] == BLOCKED, 'reinitialize_negative_verdict')
        require(len(child_rows) == 2 and all(not alive(x['pid']) for x in child_rows), 'mcp_children_not_reaped')
        report.update(qualified=True, api_calls=len(state['api']), native_exit=0,
                      prompt_count=prompt_count, mcp_old_dead_before_release=True,
                      mcp_new_alive_before_release=True, mcp_children_gone=True,
                      reinitialize_blocks_prompt=args.scenario == 'reinitialize-negative')
    except Exception as error:
        report['qualified'] = False
        report['failure'] = str(error) if isinstance(error, AssertionError) else type(error).__name__
    finally:
        if native:
            try:
                os.killpg(native.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            native.wait(timeout=5)
            if not child_rows and audit.is_file() and not audit.is_symlink() and audit.stat().st_size < 8192:
                child_rows = [json.loads(x) for x in audit.read_text().splitlines()][:2]
            until = time.monotonic() + 2
            while any(alive(x['pid']) for x in child_rows) and time.monotonic() < until:
                time.sleep(0.02)
            report['cleanup_children_gone'] = all(not alive(x['pid']) for x in child_rows)
            if not report['cleanup_children_gone']:
                report.update(qualified=False, cleanup_failure='cleanup_children_not_gone')
        if server:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        if root:
            require(shutil.rmtree.avoids_symlink_attacks and not root.is_symlink(), 'symlink_safe_cleanup_required')
            shutil.rmtree(root)
            report['temporary_state_removed'] = not root.exists()
        output = pathlib.Path(args.report)
        with output.open('x') as handle:
            json.dump(report, handle, sort_keys=True)
            handle.write('\n')
        print(json.dumps(report, sort_keys=True))
    return 0 if report['qualified'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native-executable', required=True)
    parser.add_argument('--scenario', choices=['direct-mcp', 'reinitialize-negative'], required=True)
    parser.add_argument('--report', required=True, help='New report file; parent directory must exist')
    raise SystemExit(main(parser.parse_args()))

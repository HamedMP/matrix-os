// REQUIRED offline gate executes before the actual bundled production router.
import '/fixture/gate.mjs';
import { createClaudeRoutineHook } from '/fixture/router.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const root = `/tmp/owned/production-router-${randomUUID()}`;
const command = 'matrix routines list --json';
const original = 'ORIGINAL_SYNTHETIC', rewritten = 'REWRITTEN_SYNTHETIC';
const rewrittenCommand = `printf '%s\\n' ${rewritten}`;
const toolId = `toolu_owned_${randomUUID().replaceAll('-', '')}`;
const state = { ack: false, hooksApplied: false, inputAfterAck: false, version: null, bashAvailable: false,
  partialBeforeCallback: false, callback: false, callbackCorrelated: false, executeCount: 0,
  allowResponse: false, denyResponse: false, nativeToolResult: null, nativeResult: false,
  apiRequests: 0, tokenCountRequests: 0, headRequests: 0 };
const abort = new AbortController(), sockets = new Set();
let child, hook, initializeId, callbackId, callbackRequestId, timer, forceTimer;
let nativeClosed = false, stopping = false, exit, closePromise, failed = false, failureKind = 'fixture_or_protocol_failure';
let outputBytes = 0, stderrBytes = 0, messages = 0, carry = '', closedServer = false, removed = false, failureType;
function recordFailure(error) { failureType = error instanceof Error ? error.name : 'NonError'; }
const decoder = new StringDecoder('utf8');
function stop() {
  if (!child || nativeClosed || stopping) return;
  stopping = true; child.stdin.end();
  child.kill('SIGTERM');
  forceTimer ??= setTimeout(() => { if (!nativeClosed) child.kill('SIGKILL'); }, 1000);
}
function fail() { failed = true; stop(); }
async function waitNative(milliseconds) {
  if (nativeClosed) return true;
  let expiry;
  try {
    return await Promise.race([closePromise.then(() => true), new Promise(resolve => { expiry = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { clearTimeout(expiry); }
}
function send(value) {
  assert.ok(child && !nativeClosed && child.stdin.writable);
  const bytes = typeof value === 'string' ? value : JSON.stringify(value) + '\n';
  assert.ok(Buffer.byteLength(bytes) <= 16384);
  return new Promise((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()));
}
function results(body) {
  assert.ok(Array.isArray(body.messages) && body.messages.length <= 64);
  return body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result');
}
function sse(res, tool) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  event('message_start', { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant',
    model: 'claude-haiku-4-5-20251001', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool
    ? { type: 'tool_use', id: toolId, name: 'Bash', input: {} } : { type: 'text', text: '' } });
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool
    ? { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'Owned synthetic routine router test only' }) }
    : { type: 'text_delta', text: 'SYNTHETIC_COMPLETE' } });
  event('content_block_stop', { type: 'content_block_stop', index: 0 });
  event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', { type: 'message_stop' }); res.end();
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'HEAD' && url.pathname === '/api/hello') {
      assert.ok(++state.headRequests <= 4); res.writeHead(200, { 'content-length': '0', connection: 'close' }); res.end(); return;
    }
    assert.equal(req.method, 'POST');
    assert.ok(['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname));
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 512 * 1024); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (url.pathname.endsWith('/count_tokens')) {
      assert.ok(++state.tokenCountRequests <= 4);
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end('{"input_tokens":1}'); return;
    }
    assert.ok(++state.apiRequests <= 2); assert.equal(body.stream, true);
    if (state.apiRequests === 1) {
      assert.equal(state.ack, true); assert.equal(state.hooksApplied, true); assert.equal(state.inputAfterAck, true);
      assert.equal(results(body).length, 0); sse(res, true); return;
    }
    const blocks = results(body).filter(block => block.tool_use_id === toolId);
    assert.equal(blocks.length, 1);
    const block = blocks[0], text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
    assert.ok(Buffer.byteLength(text) <= 16384);
    state.nativeToolResult = { isError: block.is_error === true, containsOriginal: text.includes(original), containsRewritten: text.includes(rewritten) };
    sse(res, false);
  } catch (error) { recordFailure(error); if (!res.headersSent) res.writeHead(400, { connection: 'close' }); res.end('synthetic request refused'); fail(); }
});
server.maxConnections = 8; server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
server.on('connection', socket => {
  if (sockets.size >= 8) { socket.destroy(); fail(); return; }
  sockets.add(socket); socket.setTimeout(5000, () => socket.destroy()); socket.once('close', () => sockets.delete(socket));
});
server.on('error', fail);
function handle(line) {
  assert.ok(++messages <= 256);
  const value = JSON.parse(line);
  if (value.type === 'control_response' && value.response?.request_id === initializeId) {
    assert.equal(state.ack, false); assert.equal(value.response.subtype, 'success');
    state.ack = true; state.hooksApplied = value.response.response?.hooks_applied === true;
  }
  if (value.type === 'system' && value.subtype === 'init') {
    assert.equal(value.claude_code_version, '2.1.280'); state.version = value.claude_code_version;
    state.bashAvailable = Array.isArray(value.tools) && value.tools.includes('Bash');
  }
  if (value.type === 'stream_event' && value.event?.type === 'content_block_start' && value.event.content_block?.type === 'tool_use') {
    assert.equal(value.event.content_block.id, toolId); assert.equal(value.event.content_block.name, 'Bash');
    assert.equal(state.callback, false); state.partialBeforeCallback = true;
  }
  if (value.type === 'control_request') {
    const request = value.request;
    assert.equal(request?.subtype, 'hook_callback'); assert.equal(state.callback, false);
    assert.equal(state.partialBeforeCallback, true); assert.equal(state.version, '2.1.280'); assert.equal(state.bashAvailable, true);
    assert.equal(request.callback_id, callbackId); assert.equal(request.tool_use_id, toolId);
    assert.equal(request.input?.hook_event_name, 'PreToolUse'); assert.equal(request.input.tool_name, 'Bash');
    assert.equal(request.input.tool_use_id, toolId); assert.equal(request.input.tool_input?.command, command);
    assert.equal(typeof value.request_id, 'string'); assert.ok(value.request_id.length > 0 && value.request_id.length <= 256);
    callbackRequestId = value.request_id; state.callback = true; state.callbackCorrelated = true;
  }
  // Actual native values are fed exactly once, in their observed stdout order.
  const handled = hook.handle(value);
  if (value.type === 'control_request') assert.equal(handled, true);
  if (value.type === 'result') {
    assert.equal(value.is_error === true, false); state.nativeResult = true; child.stdin.end();
  }
}
try {
  for (const leaf of ['home', 'config', 'cache', 'cwd', 'tmp', 'bin']) await mkdir(`${root}/${leaf}`, { recursive: true, mode: 0o700 });
  // The original literal can only reach this harmless isolated dummy executable.
  await writeFile(`${root}/bin/matrix`, `#!/bin/sh\nprintf '%s\\n' ${original}\n`, { mode: 0o700 });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const env = { HOME: `${root}/home`, CLAUDE_CONFIG_DIR: `${root}/config`, XDG_CONFIG_HOME: `${root}/config`,
    XDG_CACHE_HOME: `${root}/cache`, TMPDIR: `${root}/tmp`, PATH: `${root}/bin:/usr/bin:/bin`, LANG: 'C.UTF-8',
    USER: 'nobody', SHELL: '/bin/sh', ANTHROPIC_API_KEY: 'owned-synthetic-not-a-real-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' };
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions', '--tools', 'Bash',
    '--model', 'claude-haiku-4-5-20251001', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--system-prompt', 'Owned offline synthetic production router fixture. Use the supplied harmless Bash tool once.'];
  child = spawn('/fixture/claude', args, { cwd: `${root}/cwd`, env, stdio: ['pipe', 'pipe', 'pipe'] });
  closePromise = new Promise(resolve => {
    child.once('error', () => { failed = true; });
    child.once('close', (code, signal) => { nativeClosed = true; exit = { code, signal }; resolve(); });
  });
  child.stdin.on('error', fail);
  hook = createClaudeRoutineHook({ signal: abort.signal,
    async write(frame) {
      const value = JSON.parse(frame);
      if (value.type === 'control_request') {
        assert.equal(value.request.subtype, 'initialize'); assert.equal(initializeId, undefined);
        initializeId = value.request_id;
        const rows = value.request.hooks?.PreToolUse; assert.equal(rows?.length, 1); assert.equal(rows[0].matcher, 'Bash');
        assert.equal(rows[0].hookCallbackIds?.length, 1); callbackId = rows[0].hookCallbackIds[0];
      } else {
        assert.equal(value.type, 'control_response'); assert.equal(value.response.request_id, callbackRequestId);
        const output = value.response.response?.hookSpecificOutput;
        assert.equal(output?.hookEventName, 'PreToolUse');
        state.allowResponse = output.permissionDecision === 'allow'; state.denyResponse = output.permissionDecision === 'deny';
        if (state.allowResponse) assert.equal(output.updatedInput?.command, rewrittenCommand);
      }
      await send(frame);
    },
    async startInput() {
      assert.equal(state.ack, true); assert.equal(state.hooksApplied, true); state.inputAfterAck = true;
      await send({ type: 'user', message: { role: 'user', content: 'Owned offline synthetic router probe. Use supplied Bash tool once.' }, parent_tool_use_id: null });
    },
    fail,
    async execute(actualCommand, signal) {
      assert.equal(actualCommand, command); assert.equal(signal.aborted, false);
      assert.equal(state.callbackCorrelated, true); assert.equal(state.partialBeforeCallback, true);
      assert.equal(++state.executeCount, 1); return rewrittenCommand;
    },
  });
  child.stdout.on('data', chunk => {
    try {
      outputBytes += chunk.length; assert.ok(outputBytes <= 512 * 1024);
      carry += decoder.write(chunk); assert.ok(Buffer.byteLength(carry) <= 128 * 1024);
      let index;
      while ((index = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, index).trim(); carry = carry.slice(index + 1); if (line) handle(line);
      }
    } catch (error) { recordFailure(error); fail(); }
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 16384) fail(); });
  timer = setTimeout(fail, 25000);
  await hook.start(); assert.equal(await waitNative(28000), true, 'actual native close within bounded observation');
  clearTimeout(timer); clearTimeout(forceTimer);
  assert.equal(carry.trim(), ''); assert.equal(failed, false); assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(state.ack, true); assert.equal(state.hooksApplied, true); assert.equal(state.inputAfterAck, true);
  assert.equal(state.version, '2.1.280'); assert.equal(state.bashAvailable, true); assert.equal(state.partialBeforeCallback, true);
  assert.equal(state.callbackCorrelated, true); assert.equal(state.apiRequests, 2); assert.equal(state.nativeResult, true);
  assert.ok(state.nativeToolResult);
  if (state.executeCount === 0 && state.denyResponse && state.nativeToolResult.isError) failureKind = 'production_router_version_gate';
  assert.equal(state.executeCount, 1, 'actual production router must execute the supported literal exactly once');
  assert.equal(state.allowResponse, true); assert.equal(state.denyResponse, false);
  assert.deepEqual(state.nativeToolResult, { isError: false, containsOriginal: false, containsRewritten: true });
} catch (error) { recordFailure(error); failed = true; stop(); }
finally {
  clearTimeout(timer);
  abort.abort();
  if (hook) await hook.close();
  if (child && !nativeClosed) { stop(); if (!await waitNative(3000)) failed = true; }
  clearTimeout(forceTimer);
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(() => { closedServer = true; resolve(); }));
  if (!child || nativeClosed) {
    try { await rm(root, { recursive: true, force: true }); removed = true; } catch (error) { recordFailure(error); failed = true; }
  } else failed = true;
  console.log(JSON.stringify({ scope: 'actual native plus bundled production router, synthetic execute only', ...state,
    passed: !failed, ...(failed ? { failureKind, failureType } : {}), nativeWait: nativeClosed, nativeExit: exit ?? null,
    serverClosed: closedServer, ownedTempRemoved: removed, cleanupPending: child && !nativeClosed ? 1 : 0, realCliInvoked: false, backendQualified: false, realAccountUsed: false }));
  if (failed) process.exitCode = 1;
}

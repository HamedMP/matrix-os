import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runClaudeBotTask } from '../../../packages/gateway/src/bots/claude-task-executor.js';
function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
}
describe('official Claude child task isolation (synthetic protocol)', () => {
  it('keeps a synchronous prompt pipe failure behind actual child drain', async () => {
    const process = Object.assign(child(), {pid:125});
    vi.spyOn(process.stdin, 'write').mockImplementation(() => {throw new Error('closed prompt pipe');});
    const running = runClaudeBotTask({command:'/trusted/claude',homePath:'/owner',cwd:'/owner/bots/test',model:'observed',prompt:'synthetic',signal:new AbortController().signal,mcpUrl:'http://127.0.0.1:1234',mcpToken:'ephemeral',spawn:()=>process});
    let settled = false;
    const caught = running.catch(error => {settled=true; return error;});
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    process.emit('exit',1,null); process.emit('close',1,null);
    expect((await caught).message).toBe('Native task did not complete');
  });
  it('retains official auth with no ambient funding, disables native tools/config and confirms result plus actual exit', async () => {
    const process = child(); const controller = new AbortController();
    const spawn = vi.fn<NonNullable<Parameters<typeof runClaudeBotTask>[0]["spawn"]>>(() => process);
    const running = runClaudeBotTask({ command: '/trusted/claude', homePath: '/owner', cwd: '/owner/bots/test', model: 'observed-model', prompt: 'synthetic',
      signal: controller.signal, mcpUrl: 'http://127.0.0.1:1234', mcpToken: 'ephemeral', spawn });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const [, args, options] = spawn.mock.calls[0]!;
    expect(args).toContain('--restricted'); expect(args).not.toContain('--bare'); expect(args).not.toContain('bypassPermissions');
    expect(args).toContain('--permission-prompts'); expect(args).toContain('none');
    expect(args).toContain('--strict-mcp-config'); expect(args).not.toContain('ephemeral');
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined(); expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'completed task', session_id: 'native_session' }) + '\n');
    let settled = false; running.then(() => { settled = true; }, () => { settled = true; }); await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); process.emit('exit', 0, null); process.emit('close', 0, null);
    expect(await running).toEqual({ text: 'completed task', sessionId: 'native_session' });
  });
  it('waits for actual child drain after Stop and rejects incomplete streams', async () => {
    const process = child(); const controller = new AbortController();
    const running = runClaudeBotTask({ command: '/trusted/claude', homePath: '/owner', cwd: '/owner/bots/test', model: 'observed-model', prompt: 'synthetic',
      signal: controller.signal, mcpUrl: 'http://127.0.0.1:1234', mcpToken: 'ephemeral', spawn: () => process });
    let settled = false; const caught = running.catch(error => { settled = true; return error; });
    controller.abort(); await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false); expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    process.emit('exit', null, 'SIGTERM'); process.emit('close', null, 'SIGTERM'); expect((await caught).message).toBe('Native task did not complete');
  });
  it('decodes split UTF8 and keeps a running child error behind exit drain', async () => {
    const process = Object.assign(child(), { pid: 123 });
    const running = runClaudeBotTask({ command: '/trusted/claude', homePath: '/owner', cwd: '/owner/bots/test', model: 'observed', prompt: 'synthetic', signal: new AbortController().signal, mcpUrl: 'http://127.0.0.1:1234', mcpToken: 'ephemeral', spawn: () => process });
    const stream = Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '完整结果', session_id: 'native_session' }) + '\n');
    for (const byte of stream) process.stdout.write(Buffer.from([byte]));
    process.emit('exit', 0, null); process.emit('close', 0, null); expect((await running).text).toBe('完整结果');
    const other = Object.assign(child(), { pid: 124 });
    const failing = runClaudeBotTask({ command: '/trusted/claude', homePath: '/owner', cwd: '/owner/bots/test', model: 'observed', prompt: 'synthetic', signal: new AbortController().signal, mcpUrl: 'http://127.0.0.1:1234', mcpToken: 'ephemeral', spawn: () => other });
    let settled = false; const caught = failing.catch(error => { settled = true; return error; });
    other.emit('error', Object.assign(new Error('kill failure'), { code: 'EACCES' })); await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); other.emit('exit', 1, null); other.emit('close', 1, null); await caught;
  });

  it('accepts final stdout bytes after exit while still requiring stream close', async () => {
    const process = child(); const running = runClaudeBotTask({ command: '/trusted/claude', homePath: '/owner', cwd: '/owner/bots/test', model: 'observed', prompt: 'synthetic', signal: new AbortController().signal, mcpUrl: 'http://127.0.0.1:1234', mcpToken: 'ephemeral', spawn: () => process });
    process.emit('exit', 0, null);
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'final bytes', session_id: 'native_session' }) + '\n');
    process.emit('close', 0, null); expect((await running).text).toBe('final bytes'); expect(process.kill).not.toHaveBeenCalled();
  });

});
it('holds first input until admitted source setup and fences the source synchronously at actual native close', async () => {
  const process = child(); let ready!: () => void, inputText = '', ended = false;
  process.stdin.on('data', chunk => { inputText += chunk.toString(); });
  const running = runClaudeBotTask({ command: '/trusted/claude', homePath: '/owner', cwd: '/owner/bots/test', model: 'fixture', prompt: 'fixture input', signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1234', mcpToken: 'fixture', spawn: () => process, onStart: () => new Promise<void>(resolve => { ready = resolve; }), onEnd: () => { ended = true; } });
  await new Promise(resolve => setImmediate(resolve)); expect(inputText).toBe(''); ready(); await new Promise(resolve => setImmediate(resolve)); expect(inputText).toBe('fixture input');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fixture_session' }) + '\n'); process.emit('exit', 0, null); process.emit('close', 0, null);
  expect(ended).toBe(true); expect((await running).text).toBe('done');
});
it('never sends first input after native close wins a pending source registration', async () => {
  const process = child(); let ready!: () => void, inputText = '', ended = false;
  process.stdin.on('data', chunk => { inputText += chunk.toString(); });
  const running = runClaudeBotTask({ command: '/trusted/claude', homePath: '/owner', cwd: '/owner/bots/test', model: 'fixture', prompt: 'must not send', signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1234', mcpToken: 'fixture', spawn: () => process, onStart: () => new Promise<void>(resolve => { ready = resolve; }), onEnd: () => { ended = true; } }).catch(error => error);
  await new Promise(resolve => setImmediate(resolve)); process.emit('exit', 1, null); process.emit('close', 1, null); expect(ended).toBe(true); ready(); await new Promise(resolve => setImmediate(resolve));
  expect(inputText).toBe(''); expect((await running).message).toBe('Native task did not complete');
});
it.each(['result', 'exit', 'failure'] as const)('fences routine source at first native %s while stdio drainage and executor completion remain pending', async stage => {
  const process = Object.assign(child(), { pid: 126 }); let ended = 0, settled = false;
  const running = runClaudeBotTask({ command: '/trusted/claude', homePath: '/owner', cwd: '/owner/bots/test', model: 'fixture', prompt: 'fixture', signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1234', mcpToken: 'fixture', spawn: () => process, onStart: async () => {}, onEnd: () => { ended++; } }).then(value => { settled = true; return value; }, error => { settled = true; return error; });
  await new Promise(resolve => setImmediate(resolve));
  const terminal = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'drained result', session_id: 'fixture_session' }) + '\n';
  if (stage === 'result') process.stdout.write(terminal);
  else if (stage === 'exit') process.emit('exit', 0, null);
  else process.emit('error', Object.assign(new Error('native transport failed'), { code: 'EPIPE' }));
  const fencedBeforeClose = ended;
  await new Promise(resolve => setImmediate(resolve)); const pendingBeforeClose = !settled;
  // A process exit may precede final buffered stdout. Authority is over, but that output must still drain.
  if (stage === 'exit') process.stdout.write(terminal);
  process.emit('exit', stage === 'failure' ? 1 : 0, null); process.emit('close', stage === 'failure' ? 1 : 0, null);
  const result = await running;
  expect(fencedBeforeClose).toBe(1); expect(pendingBeforeClose).toBe(true); expect(ended).toBe(1);
  if (stage !== 'failure') expect(result).toEqual({ text: 'drained result', sessionId: 'fixture_session' });
  else expect(result).toMatchObject({ message: 'Native task did not complete' });
});

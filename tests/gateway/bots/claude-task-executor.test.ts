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
    const spawn = vi.fn(() => process);
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

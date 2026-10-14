import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createSupervisor, createLabServer, parseControl, configureHumanControl } from '../../scripts/spikes/browser-vps/supervisor.mjs';

function rig() {
  const processes: any[] = [];
  const spawn = vi.fn(() => {
    const p: any = new EventEmitter();
    p.pid = 100 + processes.length;
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    processes.push(p); return p;
  });
  const terminate = vi.fn(async () => {});
  const setHumanControl = vi.fn(async (_enabled: boolean) => undefined);
  const supervisor = createSupervisor({ spawn, terminate, setHumanControl, timeoutMs: 1000 });
  return { supervisor, processes, spawn, terminate, setHumanControl };
}

describe('browser lab supervision', () => {
  it('drains an in-flight native operation before shutdown disables human control', async () => {
    const { supervisor, setHumanControl } = rig();
    let release!: () => void;
    const operation = supervisor.control({ action: 'takeover' }, () => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const gateCount = setHumanControl.mock.calls.length;
    let finished = false;
    const shutdown = supervisor.close().then(() => { finished = true; });
    try {
      await expect(supervisor.control({ action: 'stop' })).rejects.toThrow('closed');
      await Promise.resolve(); expect(finished).toBe(false);
      expect(setHumanControl).toHaveBeenCalledTimes(gateCount);
      release(); await operation; await shutdown;
      expect(setHumanControl).toHaveBeenLastCalledWith(false);
      expect(supervisor.status().humanControlAvailable).toBe(false);
    } finally { release?.(); await shutdown; }
  });
  it('bounds queued operations and rejects expired controls before applying their effects', async () => {
    const { supervisor, setHumanControl } = rig();
    let release!: () => void;
    const active = supervisor.control({ action: 'takeover' }, () => new Promise<void>(resolve => { release = resolve; }));
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const pending = Array.from({ length: 15 }, () => supervisor.control({ action: 'stop' }));
      const outcomes = pending.map(promise => promise.then(() => 'applied', () => 'expired'));
      await expect(supervisor.control({ action: 'stop' })).rejects.toThrow();
      const before = setHumanControl.mock.calls.length;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9000);
      release(); await active;
      expect(await Promise.all(outcomes)).toEqual(Array(15).fill('expired'));
      expect(setHumanControl).toHaveBeenCalledTimes(before);
      clock.mockRestore();
    } finally { release?.(); await supervisor.close(); }
  });
  it('serializes complete product native actions with subsequent desktop and diagnostic controls', async () => {
    const { supervisor, setHumanControl } = rig();
    const events: string[] = []; let release!: () => void;
    const native = { status: vi.fn(async () => { events.push('desktop'); return { available: true, chrome: { present: true, minimized: false } }; }),
      control: vi.fn(async ({ action }) => {
        if (action === 'restore-chrome') await new Promise<void>(resolve => { release = resolve; });
        events.push(action); return { available: true, chrome: { present: true, minimized: false } };
      }) };
    const server = createLabServer(supervisor, '/nonexistent', native);
    const address = await new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)); });
    const call = (path: string, payload: object) => new Promise<number>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${address}${path}`, { method: 'POST', headers: { Host: '127.0.0.1:8730', 'Content-Type': 'application/json' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)); });
      req.setTimeout(3000, () => req.destroy(new Error('Test deadline'))); req.once('error', reject); req.end(JSON.stringify(payload));
    });
    let requests: Promise<number>[] = [];
    try {
      const browser = call('/browser-session', { surface: 'browser' }); requests.push(browser);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const gateCount = setHumanControl.mock.calls.length;
      const desktop = call('/browser-session', { surface: 'desktop' }); requests.push(desktop);
      await new Promise(resolve => setTimeout(resolve, 20));
      const show = call('/browser-control', { action: 'show-desktop' }); requests.push(show);
      await new Promise(resolve => setTimeout(resolve, 20));
      const diagnostic = call('/control', { action: 'stop' }); requests.push(diagnostic);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(events).toEqual([]); expect(setHumanControl).toHaveBeenCalledTimes(gateCount);
      release(); expect(await Promise.all(requests)).toEqual([200, 200, 200, 200]);
      expect(events).toEqual(['restore-chrome', 'desktop', 'show-desktop']);
      expect(supervisor.status().phase).toBe('stopped');
    } finally { release?.(); await Promise.allSettled(requests); await supervisor.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('accepts only the supported strict controls', () => {
    expect(parseControl({ action: 'start', engine: 'browser-use' })).toEqual({ action: 'start', engine: 'browser-use' });
    for (const body of [null, [], { action: 'start' }, { action: 'exec', command: 'x' }, { action: 'stop', engine: 'browser-use' }, { action: 'start', engine: 'bad' }]) {
      expect(() => parseControl(body)).toThrow();
    }
  });
  it('stops automation before acknowledging takeover and rejects starts in human mode', async () => {
    const { supervisor, terminate, spawn } = rig();
    await supervisor.control({ action: 'start', engine: 'agent-browser' });
    await supervisor.control({ action: 'takeover' });
    expect(terminate).toHaveBeenCalledOnce();
    expect(supervisor.status().phase).toBe('human');
    expect(supervisor.status().humanControlAvailable).toBe(true);
    await expect(supervisor.control({ action: 'start', engine: 'browser-use' })).rejects.toThrow();
    expect(supervisor.status().phase).toBe('human');
    expect(spawn).toHaveBeenCalledOnce();
    await supervisor.close();
  });
  it('ignores late worker completion after resume creates a fresh observation', async () => {
    const { supervisor, processes, spawn } = rig();
    await supervisor.control({ action: 'start', engine: 'browser-use' });
    await supervisor.control({ action: 'takeover' });
    await supervisor.control({ action: 'resume' });
    processes[0].emit('exit', 0);
    expect(supervisor.status().phase).toBe('running');
    expect(spawn.mock.calls[1][1]).toContain('--observe');
    processes[1].emit('exit', 1);
    await vi.waitFor(() => expect(supervisor.status().phase).toBe('failed'));
    await supervisor.close();
  });
  it('bounds output, kills a worker on deadline and requires explicit resume', async () => {
    vi.useFakeTimers();
    const { supervisor, processes, terminate } = rig();
    await supervisor.control({ action: 'start', engine: 'agent-browser' });
    processes[0].stdout.emit('data', Buffer.alloc(70_000));
    await vi.advanceTimersByTimeAsync(1100);
    expect(terminate).toHaveBeenCalled();
    expect(supervisor.status().phase).toBe('failed');
    await supervisor.close(); vi.useRealTimers();
  });
  it('never leaks child output and closes workers on shutdown', async () => {
    const { supervisor, processes, terminate } = rig();
    await supervisor.control({ action: 'start', engine: 'agent-browser' });
    processes[0].stderr.emit('data', Buffer.from('secret vault data'));
    expect(JSON.stringify(supervisor.status())).not.toContain('secret');
    await supervisor.close();
    expect(terminate).toHaveBeenCalledOnce();
    await expect(supervisor.control({ action: 'resume' })).rejects.toThrow();
  });
  it('serializes controls while takeover is terminating a process', async () => {
    const { supervisor, terminate } = rig();
    let release!: () => void;
    terminate.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
    await supervisor.control({ action: 'start', engine: 'agent-browser' });
    const takeover = supervisor.control({ action: 'takeover' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const resume = supervisor.control({ action: 'resume' });
    release(); await takeover; await resume;
    expect(supervisor.status().phase).toBe('running');
    await supervisor.close();
  });
  it('acknowledges effects once and preserves progress during human takeover', async () => {
    const { supervisor } = rig();
    await supervisor.control({ action: 'start', engine: 'browser-use' });
    const epoch = supervisor.fixture().epoch;
    expect(() => supervisor.fixtureAction({ action: 'login', epoch, username: 'bad', password: 'bad' })).toThrow();
    supervisor.fixtureAction({ action: 'login', epoch, username: 'matrix-lab', password: 'synthetic-only' });
    expect(() => supervisor.fixtureAction({ action: 'verify', epoch, otp: 'invalid' })).toThrow();
    supervisor.fixtureAction({ action: 'verify', epoch, otp: supervisor.fixture().otp });
    supervisor.fixtureAction({ action: 'work', epoch, expected: 0 });
    expect(() => supervisor.fixtureAction({ action: 'work', epoch, expected: 0 })).toThrow();
    await supervisor.control({ action: 'takeover' });
    supervisor.fixtureAction({ action: 'work', epoch, expected: 1 });
    await supervisor.control({ action: 'resume' });
    expect(supervisor.fixture().workCompleted).toBe(2);
    for (let expected = 2; expected < 10; expected++) supervisor.fixtureAction({ action: 'work', epoch, expected });
    expect(supervisor.fixture().checkpoint).toBe(3);
    expect(() => supervisor.fixtureAction({ action: 'work', epoch, expected: 10 })).toThrow();
    await supervisor.close();
  });
  it('keeps human control unavailable if cleanup fails and retries cleanup on takeover', async () => {
    const { supervisor, terminate } = rig();
    await supervisor.control({ action: 'start', engine: 'agent-browser' });
    terminate.mockRejectedValueOnce(new Error('Daemon remained connected'));
    await expect(supervisor.control({ action: 'takeover' })).rejects.toThrow();
    expect(supervisor.status().phase).not.toBe('human');
    expect(supervisor.status().humanControlAvailable).toBe(false);
    await supervisor.control({ action: 'takeover' });
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(supervisor.status().phase).toBe('human');
    expect(supervisor.status().humanControlAvailable).toBe(true);
    await supervisor.close();
  });
  it('changes fixture epoch only on a new start and rejects late effects from an old run', async () => {
    const { supervisor } = rig();
    await supervisor.control({ action: 'start', engine: 'browser-use' });
    const epoch = supervisor.fixture().epoch;
    await supervisor.control({ action: 'takeover' });
    await supervisor.control({ action: 'resume' });
    expect(supervisor.fixture().epoch).toBe(epoch);
    await supervisor.control({ action: 'stop' });
    await supervisor.control({ action: 'start', engine: 'agent-browser' });
    expect(supervisor.fixture().epoch).toBe(epoch + 1);
    expect(() => supervisor.fixtureAction({ action: 'login', epoch, username: 'matrix-lab', password: 'synthetic-only' })).toThrow();
    expect(supervisor.fixture().checkpoint).toBe(0);
    await supervisor.close();
  });
  it('disables viewer input before spawn or termination and enables only after cleanup', async () => {
    const { supervisor, spawn, terminate, setHumanControl } = rig();
    await supervisor.control({ action: 'start', engine: 'browser-use' });
    expect(setHumanControl).toHaveBeenLastCalledWith(false);
    expect(setHumanControl.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]);
    await supervisor.control({ action: 'takeover' });
    expect(setHumanControl.mock.calls.map(call => call[0])).toEqual([false, false, true]);
    expect(setHumanControl.mock.invocationCallOrder[1]).toBeLessThan(terminate.mock.invocationCallOrder[0]);
    expect(terminate.mock.invocationCallOrder[0]).toBeLessThan(setHumanControl.mock.invocationCallOrder[2]);
    await supervisor.control({ action: 'resume' });
    expect(setHumanControl).toHaveBeenLastCalledWith(false);
    await supervisor.close();
    expect(setHumanControl).toHaveBeenLastCalledWith(false);
  });
  it('does not spawn or acknowledge human mode when viewer input gating fails', async () => {
    const { supervisor, spawn, setHumanControl } = rig();
    setHumanControl.mockRejectedValueOnce(new Error('Gate unavailable'));
    await expect(supervisor.control({ action: 'start', engine: 'browser-use' })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    setHumanControl.mockRejectedValueOnce(new Error('Gate unavailable'));
    await expect(supervisor.control({ action: 'takeover' })).rejects.toThrow();
    expect(supervisor.status().phase).not.toBe('human');
    await supervisor.close();
  });
  it('still terminates automation when disabling the input gate fails on shutdown', async () => {
    const { supervisor, terminate, setHumanControl } = rig();
    await supervisor.control({ action: 'start', engine: 'browser-use' });
    setHumanControl.mockRejectedValueOnce(new Error('Gate unavailable'));
    await expect(supervisor.close()).rejects.toThrow();
    expect(terminate).toHaveBeenCalledOnce();
    expect(supervisor.status().humanControlAvailable).toBe(false);
  });
  it('enables human input on a successful completed fixture only after exit cleanup', async () => {
    const { supervisor, processes, terminate, setHumanControl } = rig();
    await supervisor.control({ action: 'start', engine: 'browser-use' });
    const epoch = supervisor.fixture().epoch;
    supervisor.fixtureAction({ action: 'login', epoch, username: 'matrix-lab', password: 'synthetic-only' });
    supervisor.fixtureAction({ action: 'verify', epoch, otp: supervisor.fixture().otp });
    for (let expected = 0; expected < 10; expected++) supervisor.fixtureAction({ action: 'work', epoch, expected });
    processes[0].emit('exit', 0);
    await vi.waitFor(() => expect(supervisor.status().phase).toBe('completed'));
    expect(supervisor.status().humanControlAvailable).toBe(true);
    expect(terminate.mock.invocationCallOrder[0]).toBeLessThan(setHumanControl.mock.invocationCallOrder.at(-1)!);
    await supervisor.close();
  });
  it('keeps human input disabled when a worker exits successfully without completing the fixture', async () => {
    const { supervisor, processes, setHumanControl } = rig();
    await supervisor.control({ action: 'start', engine: 'browser-use' });
    processes[0].emit('exit', 0);
    await vi.waitFor(() => expect(supervisor.status().phase).toBe('failed'));
    expect(supervisor.status().humanControlAvailable).toBe(false);
    expect(setHumanControl.mock.calls.every(call => call[0] === false)).toBe(true);
    await supervisor.close();
  });
  it('verifies both actual Kasm input parameters and fails closed on mismatched readback', async () => {
    const execute = vi.fn(async (_binary: string, args: string[]) => ({ stdout: args.includes('-get') ? '0\n' : '', stderr: '' }));
    await configureHumanControl(false, execute);
    expect(execute.mock.calls.map(call => call[1])).toEqual([
      ['-display', ':7', '-set', 'AcceptPointerEvents=0'], ['-display', ':7', '-set', 'AcceptKeyEvents=0'],
      ['-display', ':7', '-get', 'AcceptPointerEvents'], ['-display', ':7', '-get', 'AcceptKeyEvents'],
    ]);
    await expect(configureHumanControl(true, execute)).rejects.toThrow('verification');
  });
  it('waits for both input gate writes before reporting a failed change', async () => {
    let finish!: () => void;
    const execute = vi.fn(async (_binary: string, args: string[]) => {
      if (args[3]?.startsWith('AcceptPointerEvents=')) throw new Error('Pointer gate unavailable');
      return await new Promise<{ stdout: string; stderr: string }>(resolve => { finish = () => resolve({ stdout: '', stderr: '' }); });
    });
    let settled = false;
    const change = configureHumanControl(true, execute).catch(() => { settled = true; });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const early = await Promise.race([change.then(() => 'settled'), new Promise<string>(resolve => setTimeout(() => resolve('pending'), 25))]);
    expect(early).toBe('pending');
    expect(settled).toBe(false);
    finish(); await change;
    expect(settled).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('rejects loopback Host rebinding, non-JSON and oversized HTTP controls', async () => {
    const { supervisor, spawn } = rig();
    const server = createLabServer(supervisor, '/nonexistent');
    const address = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
    const call = (payload: string, extra: Record<string, string> = {}) => new Promise<{status: number}>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${address}/control`, { method: 'POST', headers: {
        Host: '127.0.0.1:8730', 'Content-Type': 'application/json', ...extra,
      } }, response => { response.resume(); response.once('end', () => resolve({ status: response.statusCode! })); });
      req.setTimeout(1000, () => req.destroy(new Error('HTTP test deadline')));
      req.once('error', reject); req.end(payload);
    });
    try {
      expect((await call('{"action":"stop"}', { Host: 'attacker.test:8730' })).status).toBe(403);
      expect((await call('{"action":"stop"}', { 'Content-Type': 'text/plain' })).status).toBe(415);
      expect((await call(JSON.stringify({ action: 'stop', extra: 'x' }))).status).toBe(400);
      expect((await call(JSON.stringify({ action: 'stop', extra: 'x'.repeat(2000) }))).status).toBe(413);
      expect((await call('{"action":"start","engine":"browser-use"}')).status).toBe(200);
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await supervisor.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('wires product restore after acknowledged takeover and reports unavailable native services truthfully', async () => {
    const { supervisor } = rig();
    const native = { status: vi.fn(async () => ({ available: true, chrome: { present: true, minimized: true } })), control: vi.fn(async () => {
      expect(supervisor.status().humanControlAvailable).toBe(true);
      return { available: true, chrome: { present: true, minimized: false } };
    }) };
    const server = createLabServer(supervisor, '/nonexistent', native);
    const address = await new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)); });
    const call = (path: string, payload?: string) => new Promise<{ status: number; json: any }>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${address}${path}`, { method: payload ? 'POST' : 'GET', headers: { Host: '127.0.0.1:8730', 'Content-Type': 'application/json' } }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, json: JSON.parse(body) }));
      });
      request.setTimeout(1000, () => request.destroy(new Error('HTTP deadline'))); request.on('error', reject); request.end(payload);
    });
    try {
      expect((await call('/browser-status')).json).toEqual({ available: true, chrome: { present: true, minimized: true }, humanControlAvailable: false });
      expect((await call('/browser-control', '{"action":"restore-chrome"}')).json.chrome.minimized).toBe(false);
      const before = native.control.mock.calls.length;
      expect((await call('/browser-session', '{"surface":"desktop"}')).json.humanControlAvailable).toBe(true);
      expect(native.control.mock.calls).toHaveLength(before);
      expect((await call('/browser-session', '{"surface":"browser"}')).json.chrome.minimized).toBe(false);
      expect((await call('/browser-control', '{"action":"restore-chrome","url":"private"}')).status).toBe(400);
      native.control.mockRejectedValueOnce(new Error('private internal unavailable path'));
      const failed = await call('/browser-control', '{"action":"restore-chrome"}');
      expect(failed.status).toBe(502); expect(JSON.stringify(failed.json)).not.toContain('private');
    } finally { await supervisor.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

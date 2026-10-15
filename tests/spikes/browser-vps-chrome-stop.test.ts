import { describe, expect, it, vi } from 'vitest';
import { stopChrome, validateBrowserSocket } from '../../scripts/spikes/browser-vps/chrome-graceful-stop.mjs';

class FakeSocket {
  static sent: any[] = [];
  static instances: FakeSocket[] = [];
  readyState = 0;
  listeners = new Map<string, Set<(event: any) => void>>();
  constructor(public url: string) { FakeSocket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
  addEventListener(name: string, callback: any) { const list = this.listeners.get(name) ?? new Set(); list.add(callback); this.listeners.set(name, list); }
  removeEventListener(name: string, callback: any) { this.listeners.get(name)?.delete(callback); }
  emit(name: string, event = {}) { for (const callback of this.listeners.get(name) ?? []) callback(event); }
  send(data: string) { FakeSocket.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
}
const socketUrl = 'ws://127.0.0.1:9222/devtools/browser/a123-b456';
function rig() {
  FakeSocket.sent = []; FakeSocket.instances = [];
  let now = 0, alive = true;
  const readProcess = vi.fn(async () => alive ? { state: 'S', startTime: '100' } : null);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: socketUrl })));
  const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; alive = false; });
  return { options: { mainPid: 400, fetch, Socket: FakeSocket, readProcess, now: () => now, sleep, timeoutMs: 1000 }, readProcess, fetch, sleep };
}

describe('Chrome profile-preserving service stop', () => {
  it('closes the browser-level CDP session then waits until the actual service process exits', async () => {
    const { options, readProcess, fetch } = rig();
    expect(await stopChrome(options)).toEqual({ status: 'gracefully_stopped' });
    expect(FakeSocket.sent).toEqual([{ id: 1, method: 'Browser.close' }]);
    expect(readProcess).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:9222/json/version');
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });
  it('uses integer abort deadlines with a fractional monotonic clock', async () => {
    const { options } = rig(); let reads = 0;
    options.now = () => reads++ === 0 ? 0.25 : 0.5;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      expect(Number.isInteger(milliseconds)).toBe(true);
      return new AbortController().signal;
    });
    try { expect(await stopChrome(options)).toEqual({ status: 'gracefully_stopped' }); }
    finally { timeout.mockRestore(); }
  });
  it('does not attach or issue Browser.close when systemd main process has already exited', async () => {
    const { options, readProcess, fetch } = rig(); readProcess.mockResolvedValue(null);
    expect(await stopChrome(options)).toEqual({ status: 'already_stopped' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects external, credentialed, redirected, page-level and alternate-port socket URLs', () => {
    expect(validateBrowserSocket(socketUrl)).toBe(socketUrl);
    for (const url of ['ws://attacker.test:9222/devtools/browser/id', 'ws://127.0.0.1:9223/devtools/browser/id', 'ws://x:y@127.0.0.1:9222/devtools/browser/id', 'ws://127.0.0.1:9222/devtools/page/id', socketUrl + '?token=x', 'wss://127.0.0.1:9222/devtools/browser/id']) {
      expect(() => validateBrowserSocket(url)).toThrow();
    }
  });
  it('fails within the bounded deadline if Browser.close does not stop the process', async () => {
    const { options, sleep } = rig(); let clock = 0; options.now = () => clock;
    sleep.mockImplementation(async _ms => { clock = 2000; });
    await expect(stopChrome(options)).rejects.toThrow('deadline');
  });
  it('treats a zombie or reused PID as the original service having exited', async () => {
    for (const next of [{ state: 'Z', startTime: '100' }, { state: 'S', startTime: '200' }]) {
      const { options, readProcess } = rig(); readProcess.mockResolvedValueOnce({ state: 'S', startTime: '100' }).mockResolvedValue(next);
      expect(await stopChrome(options)).toEqual({ status: 'gracefully_stopped' });
    }
  });
  it('bounds CDP version output and never forwards upstream errors', async () => {
    const { options, fetch } = rig(); fetch.mockResolvedValue(new Response('x'.repeat(20_000)));
    await expect(stopChrome(options)).rejects.toThrow('version response');
    expect(FakeSocket.sent).toEqual([]);
  });
  it('logs only a fixed category and closes the socket when Chrome.close cannot be sent', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class FailedSend extends FakeSocket {
      send() { const error = new Error('private invoice cookie'); error.name = 'private credential'; throw error; }
    }
    try {
      const { options } = rig();
      await expect(stopChrome({ ...options, Socket: FailedSend })).rejects.toThrow('Browser close command failed');
      expect(log).toHaveBeenCalledWith('[browser-lab] chrome_close: operation_failed');
      expect(FakeSocket.instances.at(-1)?.readyState).toBe(3);
      expect(FakeSocket.sent).toEqual([]);
    } finally { log.mockRestore(); }
  });
});

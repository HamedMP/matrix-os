import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { gateErrorLine, logGateEvent } from '../../scripts/ci/gate-log.mjs';

// The controller log is public: only plain, static helper messages are printed verbatim.
describe('gate error lines', () => {
  it('keeps plain helper messages', () => {
    expect(gateErrorLine(new Error('Current main source is stale'))).toBe('Current main source is stale');
    expect(gateErrorLine(new Error("Main coverage decision artifact missing or duplicated (v1)"))).toBe('Main coverage decision artifact missing or duplicated (v1)');
    expect(gateErrorLine(new Error('Invalid controller/requesting lease identity; retry'))).toBe('Invalid controller/requesting lease identity; retry');
  });

  it.each([
    ['a URL', 'API rate limit exceeded. See https://docs.github.com/rest for details'],
    ['a host name', 'getaddrinfo ENOTFOUND results.blob.core.windows.net'],
    ['a path', 'ENOENT: no such file /home/runner/work/x'],
    ['a long message', 'x'.repeat(200)],
  ])('redacts %s to the error kind', (_name, message) => {
    const error = Object.assign(new Error(message), { name: 'HttpError', status: 403 });
    expect(gateErrorLine(error)).toBe('unexpected HttpError (status 403)');
  });

  it('strips line breaks and control characters before deciding', () => {
    expect(gateErrorLine(new Error('Current main\r\nsource\u001b[2K is stale'))).toBe('unexpected Error');
    expect(gateErrorLine(new Error('First line only\nsecond line'))).toBe('First line only');
  });

  it('never throws while formatting, so the failure write still happens', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', { get() { throw new TypeError('boom'); } });
    expect(gateErrorLine(hostile)).toBe('unexpected unformattable error');
    for (const thrown of ['a string', { token: 'ghs_secret' }]) {
      const getter = new Error('x');
      Object.defineProperty(getter, 'message', { get() { throw thrown; } });
      expect(gateErrorLine(getter)).toBe('unexpected unformattable error');
      const status = Object.assign(new Error('bad: host.example.com'), {});
      Object.defineProperty(status, 'status', { get() { throw thrown; } });
      expect(gateErrorLine(status)).toBe('unexpected unformattable error');
    }
    const named = Object.assign(new Error('Plain message'), { name: Symbol('weird') as unknown as string });
    expect(gateErrorLine(named)).toBe('Plain message');
  });

  it('logs one shared line format for both gates', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      logGateEvent('Main source qualification failed', 'decision', new Error('Receipt missing'));
      expect(warn).toHaveBeenCalledWith('Main source qualification failed at decision: Receipt missing');
    } finally { warn.mockRestore(); }
  });

  it('never prints a non-Error value', () => {
    expect(gateErrorLine({ token: 'ghs_secret' })).toBe('unexpected non-Error value');
  });
});

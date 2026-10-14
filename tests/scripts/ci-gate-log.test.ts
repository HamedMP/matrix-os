import { describe, expect, it } from 'vitest';
import { gateErrorLine } from '../../scripts/ci/gate-log.mjs';

// The controller log is public: only plain, static helper messages are printed verbatim.
describe('gate error lines', () => {
  it('keeps plain helper messages', () => {
    expect(gateErrorLine(new Error('Current main source is stale'))).toBe('Current main source is stale');
    expect(gateErrorLine(new Error("Main coverage decision artifact missing or duplicated (v1)"))).toBe('Main coverage decision artifact missing or duplicated (v1)');
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

  it('never prints a non-Error value', () => {
    expect(gateErrorLine({ token: 'ghs_secret' })).toBe('unexpected non-Error value');
  });
});

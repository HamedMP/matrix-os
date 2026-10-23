import { describe, expect, it, vi } from 'vitest';
import { BrowserLabFailure, failureCategory, reportBrowserFailure } from '../../scripts/spikes/browser-vps/safe-errors.mjs';

describe('content-free browser diagnostics', () => {
  it.each(['tool_deadline', 'tool_output_limit', 'tool_failed', 'tool_start_failed', 'fixture_deadline', 'fixture_replaced', 'invalid_response', 'service_unavailable'])('retains the fixed failure category %s', category => {
    expect(failureCategory(new BrowserLabFailure(category))).toBe(category);
  });
  it('never prints arbitrary error names, messages, values or payloads', () => {
    const log = vi.fn();
    const privateError = new Error('password=private page invoice'); privateError.name = 'cookie=private';
    for (const error of [privateError, { name: 'private title', message: 'private credential' }, 'private secret']) {
      reportBrowserFailure('runner', error, log);
    }
    expect(log.mock.calls).toEqual(Array(3).fill(['[browser-lab] runner: operation_failed']));
  });
  it('classifies built-in request/parse failures without their private messages', () => {
    expect(failureCategory(new DOMException('private', 'TimeoutError'))).toBe('request_deadline');
    expect(failureCategory(new DOMException('private', 'AbortError'))).toBe('request_aborted');
    expect(failureCategory(new SyntaxError('private body'))).toBe('invalid_response');
    expect(failureCategory(new TypeError('private URL'))).toBe('request_failed');
  });
  it('rejects arbitrary categories and confines log contexts', () => {
    expect(() => new BrowserLabFailure('private cookie')).toThrow('Invalid failure category');
    const error = new BrowserLabFailure('tool_failed'); error.category = 'private cookie';
    const log = vi.fn(); reportBrowserFailure('private credential', error, log);
    expect(log).toHaveBeenCalledWith('[browser-lab] operation: operation_failed');
  });
});

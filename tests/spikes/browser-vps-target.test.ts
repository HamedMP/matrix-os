import { describe, expect, it } from 'vitest';
import { assertBrowserLabTarget } from '../../scripts/spikes/browser-vps/target-guard.mjs';

describe('browser lab installation boundary', () => {
  const valid = 'MATRIX_HANDLE=pr-2526\nMATRIX_RUNTIME_SLOT=pr-2526\n';
  it('accepts an explicitly classified disposable preview', () => {
    expect(assertBrowserLabTarget(valid, 'pr-2526')).toBe('pr-2526');
  });
  it.each([
    'MATRIX_HANDLE=hamedmp\nMATRIX_RUNTIME_SLOT=pr-2526\n',
    'MATRIX_HANDLE=pr-2526\nMATRIX_RUNTIME_SLOT=primary\n',
    'MATRIX_HANDLE=pr-2526\n',
    'MATRIX_HANDLE=pr-2526\nMATRIX_HANDLE=pr-2527\nMATRIX_RUNTIME_SLOT=pr-2526\n',
    'MATRIX_HANDLE="$(touch /tmp/unsafe)"\nMATRIX_RUNTIME_SLOT=pr-2526\n',
  ])('rejects primary, unclassified, duplicate or executable metadata', (env) => {
    expect(() => assertBrowserLabTarget(env, 'pr-2526')).toThrow('Target is not the confirmed disposable preview');
  });
  it('rejects a different preview even when it is correctly classified', () => {
    expect(() => assertBrowserLabTarget(valid, 'pr-2527')).toThrow();
  });
  it('ignores unrelated secrets and never executes shell expressions', () => {
    expect(assertBrowserLabTarget(valid + 'TOKEN=$(false)\n', 'pr-2526')).toBe('pr-2526');
  });
});

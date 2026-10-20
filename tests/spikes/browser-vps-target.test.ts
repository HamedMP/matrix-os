import { describe, expect, it } from 'vitest';
import { assertBrowserLabTarget } from '../../scripts/spikes/browser-vps/target-guard.mjs';

describe('browser lab installation boundary', () => {
  const valid = 'MATRIX_HANDLE=pr-2526\nMATRIX_RUNTIME_SLOT=pr-2526\n';
  it('accepts an explicitly classified disposable preview', () => {
    expect(assertBrowserLabTarget(valid, 'pr-2526')).toBe('pr-2526');
  });
  it('accepts the exact owner-only Private Preview classification', () => {
    const handle = 'pv-2722-3fa91c2e';
    expect(assertBrowserLabTarget(`MATRIX_HANDLE=${handle}\nMATRIX_RUNTIME_SLOT=${handle}\n`, handle)).toBe(handle);
  });
  it.each(['pv-0-3fa91c2e', 'pv-02722-3fa91c2e', 'pv-2722-3FA91C2E', 'pv-2722-3fa91c2',
    'pv-2722-3fa91c2ee', 'pv-2722-../../primary', 'pv-1234567890-3fa91c2e'])('rejects malformed Private Preview %s', handle => {
    expect(() => assertBrowserLabTarget(`MATRIX_HANDLE=${handle}\nMATRIX_RUNTIME_SLOT=${handle}\n`, handle)).toThrow();
  });
  it('rejects a Private Preview pointed at primary, a different preview or duplicate metadata', () => {
    const handle = 'pv-2722-3fa91c2e';
    for (const slot of ['primary', 'pr-2722', 'pv-2722-aaaaaaaa']) {
      expect(() => assertBrowserLabTarget(`MATRIX_HANDLE=${handle}\nMATRIX_RUNTIME_SLOT=${slot}\n`, handle)).toThrow();
    }
    expect(() => assertBrowserLabTarget(`MATRIX_HANDLE=${handle}\nMATRIX_HANDLE=${handle}\nMATRIX_RUNTIME_SLOT=${handle}\n`, handle)).toThrow();
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

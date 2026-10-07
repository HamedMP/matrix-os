import { promisify } from "node:util";
import { verifyNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { execFile, spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createHermesNativeAccountMetadataReader, HERMES_NATIVE_METADATA_SCRIPT } from '../../packages/gateway/src/ai-providers/hermes-native-account-metadata.js';
const prelude = `
import sys, types, json
for name in ['hermes_cli', 'hermes_cli.auth', 'hermes_cli.auth_codex', 'agent', 'agent.codex_headers', 'httpx']:
    sys.modules[name] = types.ModuleType(name)
auth = sys.modules['hermes_cli.auth']
auth.AuthError = type('AuthError', (Exception,), {})
auth._read_codex_tokens = lambda **kwargs: {'tokens': {'access_token': 'fixture-native-token', 'id_token': 'fixture-id-token'}}
sys.modules['hermes_cli.auth_codex']._pool_codex_access_token = lambda: ''
sys.modules['hermes_cli.auth_codex']._decode_jwt_claims = lambda token: {'email': 'hermes@example.test'}
sys.modules['agent.codex_headers'].codex_account_headers = lambda token: {}
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def raise_for_status(self): pass
    def iter_bytes(self): yield json.dumps({'rate_limit': {'primary_window': {'used_percent': 30, 'limit_window_seconds': 18000, 'reset_at': 1790931600}}, 'private': 'never-output'}).encode()
class Client(Response):
    def __init__(self, **kwargs): assert kwargs['follow_redirects'] is False
    def stream(self, method, url, **kwargs):
        assert url == 'https://chatgpt.com/backend-api/wham/usage'
        return Response()
sys.modules['httpx'].Client = Client
`;
function evaluate(override = '', verifyOnly = false) {
  const result = spawnSync('python3', ['-c', prelude + override + HERMES_NATIVE_METADATA_SCRIPT, ...(verifyOnly ? ['--verify-only'] : [])], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  expect(result.status).toBe(0);
  return result.stdout;
}
describe('Hermes safe native metadata helper', () => {
  it('projects exact Hermes identity and window using fixed native endpoint without credentials', () => {
    const text = evaluate();
    expect(JSON.parse(text)).toMatchObject({ account: { email: 'hermes@example.test' }, limits: { rateLimits: { primary: { usedPercent: 30 } } } });
    expect(text).not.toContain('fixture-native-token');
    expect(text).not.toContain('never-output');
  });
  it('suppresses native helper stdout and stderr instead of returning credential-shaped diagnostics', () => {
    const text = evaluate("def noisy(**kwargs):\n    print('fixture-native-token')\n    print('fixture-secret', file=sys.stderr)\n    return {'tokens': {'access_token': 'fixture-native-token'}}\nauth._read_codex_tokens = noisy\n");
    expect(JSON.parse(text)).toMatchObject({ account: { email: 'hermes@example.test' } });
    expect(text).not.toContain('fixture-native-token');
  });
  it('keeps identity when quota is unavailable without refreshing/importing credentials', () => {
    const text = evaluate("sys.modules['httpx'].Client = lambda **kwargs: (_ for _ in ()).throw(RuntimeError('private error'))\n");
    expect(JSON.parse(text)).toEqual({ account: { type: 'chatgpt', email: 'hermes@example.test' }, binding: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it('drops account generation switches', () => {
    const text = evaluate("reads = iter(['fixture-native-token', 'different-token'])\nauth._read_codex_tokens = lambda **kwargs: {'tokens': {'access_token': next(reads)}}\n");
    expect(JSON.parse(text)).toBeNull();
  });
  it('does not guess missing account identity', () => {
    expect(JSON.parse(evaluate("sys.modules['hermes_cli.auth_codex']._decode_jwt_claims = lambda token: {}\n"))).toBeNull();
  });
  it('validates singleton and pool selection privately without a usage request or credential refresh', () => {
    const singleton = JSON.parse(evaluate("sys.modules['httpx'].Client = lambda **kwargs: (_ for _ in ()).throw(AssertionError('no request'))\n", true));
    const pool = JSON.parse(evaluate("auth._read_codex_tokens = lambda **kwargs: (_ for _ in ()).throw(auth.AuthError())\nsys.modules['hermes_cli.auth_codex']._pool_codex_access_token = lambda: 'pool-selected-token'\n", true));
    expect(Object.keys(singleton)).toEqual(['binding']);
    expect(pool.binding).not.toBe(singleton.binding);
    expect(JSON.stringify(pool)).not.toContain('pool-selected-token');
  });

  it('compares each observation proof independently when selected-profile verification coalesces', async () => {
    let clock = new Date('2026-10-02T08:00:00Z'); let reads = 0;
    let resolveSelection!: (value: { stdout: string }) => void;
    const probe = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('--verify-only')) return new Promise<{ stdout: string }>(resolve => { resolveSelection = resolve; });
      reads += 1;
      return { stdout: JSON.stringify({ account: { type: 'chatgpt', email: reads === 1 ? 'old@example.test' : 'new@example.test' }, binding: (reads === 1 ? 'a' : 'b').repeat(64) }) };
    });
    const execute = Object.assign(vi.fn(), { [promisify.custom]: probe }) as unknown as typeof execFile;
    const reader = createHermesNativeAccountMetadataReader({ homePath: '/runtime/home', now: () => clock, execute });
    const old = await reader(); clock = new Date(clock.getTime() + 6000); const newer = await reader();
    const first = verifyNativeAccountMetadata(old); const second = verifyNativeAccountMetadata(newer);
    resolveSelection({ stdout: JSON.stringify({ binding: 'a'.repeat(64) }) });
    expect(await first).toBe(old);
    expect(await second).toBeNull();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(old)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(newer)).not.toContain('b'.repeat(64));
  });

});

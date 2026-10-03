import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { HERMES_NATIVE_METADATA_SCRIPT } from '../../packages/gateway/src/ai-providers/hermes-native-account-metadata.js';
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
function evaluate(override = '') {
  const result = spawnSync('python3', ['-c', prelude + override + HERMES_NATIVE_METADATA_SCRIPT], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
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
    expect(JSON.parse(text)).toEqual({ account: { type: 'chatgpt', email: 'hermes@example.test' } });
  });
  it('drops account generation switches', () => {
    const text = evaluate("reads = iter(['fixture-native-token', 'different-token'])\nauth._read_codex_tokens = lambda **kwargs: {'tokens': {'access_token': next(reads)}}\n");
    expect(JSON.parse(text)).toBeNull();
  });
  it('does not guess missing account identity', () => {
    expect(JSON.parse(evaluate("sys.modules['hermes_cli.auth_codex']._decode_jwt_claims = lambda token: {}\n"))).toBeNull();
  });
});

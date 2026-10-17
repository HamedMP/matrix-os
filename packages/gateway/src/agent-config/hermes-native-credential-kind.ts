import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod/v4';
import { buildHermesNativeEnvironment } from '../hermes-native-environment.js';

const Observation = z.object({ providerId: z.literal('anthropic'), modelId: z.string().min(1).max(160),
  credentialKind: z.literal('api_key') }).strict();
export type HermesNativeCredentialKind = z.infer<typeof Observation>;

/** Read-only pinned native helpers. Secrets stay in Python; no resolver, pool seed or OAuth refresh. */
export const HERMES_NATIVE_CREDENTIAL_KIND_SCRIPT = `
import json, logging, contextlib, os, re, socket, math
from pathlib import Path
class Discard:
    def write(self, text): return len(text)
    def flush(self): return None
def no_network(*args, **kwargs): raise RuntimeError("Network unavailable")
socket.socket.connect = no_network
socket.create_connection = no_network
logging.disable(logging.CRITICAL)
result = None
try:
    with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
        from hermes_cli.config import load_config_readonly, get_hermes_home
        from hermes_cli.auth import get_anthropic_key, read_credential_pool
        from agent.anthropic_credentials import read_hermes_oauth_credentials, read_claude_code_credentials
        def stable_env_pool(pool, model, key):
            if not pool: return ()
            if len(pool) != 1 or not isinstance(pool[0], dict): return None
            row = pool[0]
            allowed = {'id', 'label', 'auth_type', 'priority', 'source', 'base_url', 'secret_fingerprint',
                'request_count', 'last_status', 'last_status_at', 'last_error_code', 'last_error_reason',
                'last_error_message', 'last_error_reset_at', 'status_cleared_at', 'model_cooldowns'}
            if set(row) - allowed or row.get('auth_type') != 'api_key' or row.get('source') != 'env:ANTHROPIC_API_KEY': return None
            for field, limit in [('id', 256), ('label', 1024)]:
                value = row.get(field)
                if not isinstance(value, str) or not 0 < len(value) <= limit: return None
            if type(row.get('priority')) is not int or not -1000000 <= row['priority'] <= 1000000: return None
            if type(row.get('request_count', 0)) is not int or not 0 <= row.get('request_count', 0) <= 2**53 - 1: return None
            for field in ['last_status_at', 'status_cleared_at']:
                value = row.get(field)
                if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0): return None
            if row.get('last_status') not in (None, 'ok') or row.get('model_cooldowns'): return None
            if any(row.get(k) is not None for k in ['last_error_code', 'last_error_reason', 'last_error_message', 'last_error_reset_at']): return None
            from agent.credential_pool import get_env_prefer_dotenv
            from agent.credential_persistence import fingerprint_secret_value
            from hermes_cli.auth import PROVIDER_REGISTRY
            provider = PROVIDER_REGISTRY.get('anthropic')
            if provider is None or provider.auth_type != 'api_key': return None
            if any(get_env_prefer_dotenv(name) for name in ['ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
                'ANTHROPIC_API_KEY_2', 'ANTHROPIC_TOKEN_2', 'CLAUDE_CODE_OAUTH_TOKEN_2']): return None
            candidate = get_env_prefer_dotenv('ANTHROPIC_API_KEY')
            fingerprint = row.get('secret_fingerprint')
            if candidate != key or not isinstance(fingerprint, str) or not re.fullmatch(r'sha256:[a-f0-9]{16}', fingerprint): return None
            if fingerprint_secret_value(candidate) != fingerprint: return None
            endpoint = get_env_prefer_dotenv('ANTHROPIC_BASE_URL') or provider.inference_base_url
            if not isinstance(endpoint, str) or not endpoint: return None
            for observed in [row.get('base_url'), model.get('base_url', endpoint)]:
                if not isinstance(observed, str) or observed.rstrip('/') != endpoint.rstrip('/'): return None
            # The entire sanitized identity must remain stable across both observations.
            identity = json.dumps(row, sort_keys=True, allow_nan=False)
            return identity if len(identity) <= 4096 else None
        def observe():
            if Path(get_hermes_home()).resolve() != Path(os.environ['HERMES_HOME']).resolve(): return None
            cfg = load_config_readonly()
            if not isinstance(cfg, dict): return None
            model = cfg.get('model')
            if not isinstance(model, dict) or model.get('provider') != 'anthropic': return None
            if any(k in model for k in ['api_key', 'key_env', 'api_key_env', 'key_cmd', 'openai_runtime']): return None
            providers = cfg.get('providers', {})
            if not isinstance(providers, dict): return None
            provider = providers.get('anthropic', {})
            if provider not in ({}, {'enabled': True}): return None
            selected = model.get('default')
            if not isinstance(selected, str) or not 0 < len(selected) <= 160 or any(ord(c) < 32 for c in selected): return None
            # Only an empty pool or one proven stable env reference is unambiguous.
            # Never seed a pool or refresh a grant to resolve credential identity.
            pool = read_credential_pool('anthropic')
            if not isinstance(pool, list): return None
            for read in [read_hermes_oauth_credentials, read_claude_code_credentials]:
                creds = read()
                if creds is not None and (not isinstance(creds, dict) or creds): return None
            key = get_anthropic_key()
            if not isinstance(key, str) or len(key) > 8192 or not re.fullmatch(r'sk-ant-api[0-9]+-[A-Za-z0-9_-]+', key): return None
            pool_identity = stable_env_pool(pool, model, key)
            if pool_identity is None: return None
            return (selected, key, pool_identity)
        before = observe()
        after = observe() if before else None
        if before and before == after:
            result = {'providerId': 'anthropic', 'modelId': before[0], 'credentialKind': 'api_key'}
except Exception:
    result = None
print(json.dumps(result))
`;

/** Use the installed owner launcher, including a trusted installer target outside the home. */
export async function resolveHermesNativeRoot(homePath: string): Promise<string> {
  const home = resolve(homePath);
  const launcherPath = join(home, '.local/bin/hermes');
  const launcher = await realpath(launcherPath);
  const managedLauncher = launcher === launcherPath;
  const root = managedLauncher ? await realpath(join(home, '.hermes/hermes-agent'))
    : dirname(dirname(dirname(launcher)));
  if (!managedLauncher && (basename(launcher) !== 'hermes' || basename(dirname(launcher)) !== 'bin'
    || basename(dirname(dirname(launcher))) !== 'venv')) throw new Error('Native installation unavailable');
  if (managedLauncher) {
    const expected = `#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${root}/venv/bin/python" "${root}/hermes" "$@"\n`;
    const handle = await open(launcher, 'r');
    try {
      const metadata = await handle.stat();
      const content = Buffer.alloc(Buffer.byteLength(expected) + 1);
      const { bytesRead } = await handle.read(content, 0, content.length, 0);
      if (!metadata.isFile() || metadata.size !== Buffer.byteLength(expected)
        || bytesRead !== metadata.size || content.subarray(0, bytesRead).toString('utf8') !== expected)
        throw new Error('Native installation unavailable');
    } finally { await handle.close(); }
  }
  for (const path of [root, join(root, 'hermes_cli'), launcher, await realpath(join(root, 'venv/bin/python'))]) {
    const metadata = await lstat(path);
    if ((!metadata.isFile() && !metadata.isDirectory()) || metadata.isSymbolicLink()
      || ![0, process.getuid?.()].includes(metadata.uid) || (metadata.mode & 0o022)) throw new Error('Native installation unavailable');
  }
  return root;
}

export function createHermesNativeCredentialKindReader(input: {
  homePath: string; execute?: typeof execFile; resolveRoot?: typeof resolveHermesNativeRoot;
  logWarning?: (errorType: string) => void;
}): (signal: AbortSignal) => Promise<HermesNativeCredentialKind | null> {
  const homePath = resolve(input.homePath);
  const warn = input.logWarning ?? ((name: string) => console.warn('[agent-config] Native credential metadata unavailable:', name));
  let pending: Promise<HermesNativeCredentialKind | null> | null = null;
  return async signal => {
    signal.throwIfAborted();
    if (!pending) pending = (async () => {
      try {
        const root = await (input.resolveRoot ?? resolveHermesNativeRoot)(homePath);
        const env = buildHermesNativeEnvironment(homePath, root);
        const { stdout } = await promisify(input.execute ?? execFile)(join(root, 'venv/bin/python'), ['-c', HERMES_NATIVE_CREDENTIAL_KIND_SCRIPT], {
          cwd: root, env: { ...env, HERMES_HOME: join(homePath, '.hermes') },
          timeout: 1000, maxBuffer: 1024, killSignal: 'SIGKILL', windowsHide: true,
        });
        const raw: unknown = JSON.parse(String(stdout));
        if (raw === null) return null;
        const result = Observation.safeParse(raw);
        return result.success ? result.data : null;
      } catch (error: unknown) {
        warn(error instanceof Error ? error.name : 'UnknownError');
        return null;
      }
    })().finally(() => { pending = null; });
    const result = await pending;
    signal.throwIfAborted();
    return result;
  };
}

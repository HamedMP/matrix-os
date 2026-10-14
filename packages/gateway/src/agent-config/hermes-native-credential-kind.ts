import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod/v4';
import { buildAgentRuntimeEnvironment } from '../agent-launcher.js';

const Observation = z.object({ providerId: z.literal('anthropic'), modelId: z.string().min(1).max(160),
  credentialKind: z.literal('api_key') }).strict();
export type HermesNativeCredentialKind = z.infer<typeof Observation>;

/** Read-only pinned native helpers. Secrets stay in Python; no resolver, pool seed or OAuth refresh. */
export const HERMES_NATIVE_CREDENTIAL_KIND_SCRIPT = `
import json, logging, contextlib, os, re, socket
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
            # Pool rotation and external OAuth stores can win over a simple env lookup.
            # Their presence is ambiguous; never seed a pool or refresh a grant to resolve it.
            pool = read_credential_pool('anthropic')
            if not isinstance(pool, list) or pool: return None
            for read in [read_hermes_oauth_credentials, read_claude_code_credentials]:
                creds = read()
                if creds is not None and (not isinstance(creds, dict) or creds): return None
            key = get_anthropic_key()
            if not isinstance(key, str) or len(key) > 8192 or not re.fullmatch(r'sk-ant-api[0-9]+-[A-Za-z0-9_-]+', key): return None
            return (selected, key)
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
        const environment = buildAgentRuntimeEnvironment(homePath);
        const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
          ['HOME', 'MATRIX_HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'MATRIX_NODE_PREFIX'].includes(key)));
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

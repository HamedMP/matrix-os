import type { NativeProviderProfileGuard, NativeProviderProfile } from "./native-provider-profile-guard.js";
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, lstat, readFile, rename, rm, chmod } from 'node:fs/promises';
import type { ProviderWorkflowKey } from '@matrix-os/contracts';
import { buildAgentRuntimeEnvironment } from '../agent-launcher.js';
import { ProviderWorkflowError } from './provider-workflows.js';
/** A fixed-origin, non-billable credentials probe; persistence remains the native adapter's responsibility. */
export function createProviderKeyVerifier(options: {
  providerId: ProviderWorkflowKey['providerId'];
  save: (key: string) => Promise<void>;
  fetchFn?: typeof fetch;
  profileGuard?: NativeProviderProfileGuard;
  profile?: NativeProviderProfile;
}) {
  if (!options.save)
    throw new Error('Key persistence dependency required');
  const verify = async (input: ProviderWorkflowKey): Promise<void> => {
    if (input.providerId !== options.providerId)
      throw new ProviderWorkflowError('rejected');
    const url = { openai: 'https://api.openai.com/v1/models', anthropic: 'https://api.anthropic.com/v1/models', openrouter: 'https://openrouter.ai/api/v1/key' }[options.providerId];
    try {
      const response = await (options.fetchFn ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: options.providerId === 'anthropic' ? { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${input.apiKey}` } });
      // Never buffer an upstream body, account information or error text.
      await response.body?.cancel();
      if (response.status !== 200)
        throw new ProviderWorkflowError('rejected');
    }
    catch (error) {
      if (error instanceof ProviderWorkflowError)
        throw error;
      console.warn('[provider-workflow] Key probe unavailable:', error instanceof Error ? error.name : 'UnknownError');
      throw new ProviderWorkflowError('unavailable');
    }
    await options.save(input.apiKey);
  };
  return (input: ProviderWorkflowKey) => options.profileGuard && options.profile
    ? options.profileGuard.run(options.profile, { kind: "write" }, () => verify(input)) : verify(input);
}
/** Codex officially supports stdin for --with-api-key; argv/environment never contain the supplied secret. */
export function createCodexKeySaver(options: {
  homePath: string;
  runtimePrefix?: string;
}) {
  const homePath = resolve(options.homePath);
  const prefix = resolve(options.runtimePrefix ?? '/opt/matrix/runtime/node');
  return async (key: string): Promise<void> => {
    const destination = join(homePath, '.codex');
    if (process.env.CODEX_HOME && resolve(process.env.CODEX_HOME) !== destination)
      throw new ProviderWorkflowError('unavailable');
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const metadata = await lstat(destination);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new ProviderWorkflowError('unavailable');
    const staging = await mkdtemp(join(homePath, '.codex-key-'));
    try {
      await new Promise<void>((accept, reject) => {
        const env = { ...buildAgentRuntimeEnvironment(homePath), LANG: 'en_US.UTF-8', CODEX_HOME: staging };
        const child = spawn(join(prefix, 'bin/codex'), ['-c', 'cli_auth_credentials_store="file"', 'login', '--with-api-key'], { cwd: homePath, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let outputBytes = 0;
        let finished = false;
        let failure: Error | undefined;
        const timer = setTimeout(stop, 10000);
        timer.unref();
        // Do not remove CODEX_HOME until the native process has closed.
        function stop() { failure ??= new ProviderWorkflowError('unavailable'); child.kill('SIGKILL'); }
        function finish(error?: Error) {
          if (finished)
            return;
          finished = true;
          clearTimeout(timer);
          error ? reject(error) : accept();
        }
        const discard = (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > 65536) {
            stop();
          }
        };
        child.stdout.on('data', discard);
        child.stderr.on('data', discard);
        child.stdin.on('error', stop);
        child.on('error', () => finish(new ProviderWorkflowError('unavailable')));
        child.on('close', code => finish(failure ?? (code === 0 ? undefined : new ProviderWorkflowError('unavailable'))));
        child.stdin.end(`${key}\n`);
      });
      const stagedPath = join(staging, 'auth.json');
      const file = await lstat(stagedPath);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 65536)
        throw new ProviderWorkflowError('unavailable');
      const document = JSON.parse(await readFile(stagedPath, 'utf8'));
      if (document.OPENAI_API_KEY !== key || document.tokens)
        throw new ProviderWorkflowError('unavailable');
      await chmod(stagedPath, 0o600);
      await rename(stagedPath, join(destination, 'auth.json'));
    }
    finally {
      await rm(staging, { recursive: true, force: true });
    }
  };
}

import { NativeProviderWriteNotStartedError, type NativeProviderProfileGuard, type NativeProviderProfile } from "./native-provider-profile-guard.js";
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, lstat, readFile, rm, chmod } from 'node:fs/promises';
import type { ProviderWorkflowKey } from '@matrix-os/contracts';
import { buildAgentRuntimeEnvironment } from '../agent-launcher.js';
import { ProviderWorkflowError } from './provider-workflows.js';
import { commitCodexKey, CodexKeyRollbackFailedError } from './codex-key-transaction.js';
export interface ProviderKeySaver {
  (key: string): Promise<void>;
  connect?: (key: string, commit: () => Promise<void>) => Promise<void>;
}
export interface ProviderKeyVerifier {
  (key: ProviderWorkflowKey): Promise<void>;
  connect?: (key: ProviderWorkflowKey, commit: () => Promise<void>) => Promise<void>;
}
/** A fixed-origin, non-billable credentials probe; persistence remains the native adapter's responsibility. */
export function createProviderKeyVerifier(options: {
  providerId: ProviderWorkflowKey['providerId'];
  save: ProviderKeySaver;
  fetchFn?: typeof fetch;
  profileGuard?: NativeProviderProfileGuard;
  profile?: NativeProviderProfile;
}): ProviderKeyVerifier {
  if (!options.save)
    throw new Error('Key persistence dependency required');
  const verify = async (input: ProviderWorkflowKey, commit?: () => Promise<void>): Promise<void> => {
    if (input.providerId !== options.providerId)
      throw new ProviderWorkflowError('rejected');
    if (options.profileGuard && options.profile) {
      const release = await options.profileGuard.acquire(options.profile, { kind: "write" });
      await release();
    }
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
    // Validation has no native write side effects; only the selected saver
    // acquires durable profile admission.
    const save = () => commit ? options.save.connect!(input.apiKey, commit) : options.save(input.apiKey);
    if (options.profileGuard && options.profile) await options.profileGuard.run(options.profile, { kind: "write" }, save);
    else await save();
  };
  return Object.assign((input: ProviderWorkflowKey) => verify(input), options.save.connect
    ? { connect: (input: ProviderWorkflowKey, commit: () => Promise<void>) => verify(input, commit) } : {});
}
/** Codex officially supports stdin for --with-api-key; argv/environment never contain the supplied secret. */
export function createCodexKeySaver(options: {
  homePath: string;
  runtimePrefix?: string;
}) {
  const homePath = resolve(options.homePath);
  const prefix = resolve(options.runtimePrefix ?? '/opt/matrix/runtime/node');
  const save = async (key: string, commit: () => Promise<void>): Promise<void> => {
    const destination = join(homePath, '.codex');
    if (process.env.CODEX_HOME && resolve(process.env.CODEX_HOME) !== destination)
      throw new NativeProviderWriteNotStartedError();
    const prepared = await (async () => {
      try {
        await mkdir(destination, { recursive: true, mode: 0o700 });
        const metadata = await lstat(destination);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0)
          throw new ProviderWorkflowError('unavailable');
        // The caller holds the durable profile lease. An uncertain transaction
        // retains that lease, so only proven-safe residue can reach this point.
        // One exclusive slot bounds residue even when cleanup keeps failing.
        const staging = join(destination, '.matrix-key-staging');
        try { await mkdir(staging, { mode: 0o700 }); }
        catch (error) {
          if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const residue = await lstat(staging);
          if (!residue.isDirectory() || residue.isSymbolicLink() || residue.uid !== process.getuid?.()
            || (residue.mode & 0o777) !== 0o700) throw new ProviderWorkflowError('unavailable');
          await rm(staging, { recursive: true, force: true });
          await mkdir(staging, { mode: 0o700 });
        }
        return { metadata, staging };
      } catch (error) {
        console.warn('[provider-workflow] Codex key staging unavailable:', error instanceof Error ? error.name : 'UnknownError');
        throw new NativeProviderWriteNotStartedError();
      }
    })();
    const { metadata, staging } = prepared;
    let keepRecovery = false;
    let nativeDrained = true;
    let publishRequested = false;
    try {
      await new Promise<void>((accept, reject) => {
        const env = { ...buildAgentRuntimeEnvironment(homePath), LANG: 'en_US.UTF-8', CODEX_HOME: staging };
        const child = spawn(join(prefix, 'bin/codex'), ['-c', 'cli_auth_credentials_store="file"', 'login', '--with-api-key'], { cwd: homePath, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        nativeDrained = false;
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
        child.on('error', () => { if (child.pid === undefined) nativeDrained = true; finish(new ProviderWorkflowError('unavailable')); });
        child.on('close', code => { nativeDrained = true; finish(failure ?? (code === 0 ? undefined : new ProviderWorkflowError('unavailable'))); });
        child.stdin.end(`${key}\n`);
      });
      const stagedPath = join(staging, 'auth.json');
      const file = await lstat(stagedPath);
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== process.getuid?.() || file.size > 65536)
        throw new ProviderWorkflowError('unavailable');
      const document = JSON.parse(await readFile(stagedPath, 'utf8'));
      if (document.OPENAI_API_KEY !== key || document.tokens)
        throw new ProviderWorkflowError('unavailable');
      await chmod(stagedPath, 0o600);
      publishRequested = true;
      await commitCodexKey({ directory: destination, directoryIdentity: metadata, staging, commit });
    }
    catch (error) {
      keepRecovery = error instanceof CodexKeyRollbackFailedError || !nativeDrained;
      if (!publishRequested && nativeDrained) throw new NativeProviderWriteNotStartedError();
      throw error;
    }
    finally {
      // One uncertain transaction per durable profile lease; its private 0700
      // backup survives until operator-confirmed recovery, never a TTL unlock.
      if (!keepRecovery) {
        try { await rm(staging, { recursive: true, force: true }); }
        catch (error) {
          // Cleanup must not undo a committed result or mask a proven restore.
          // Reclaim the bounded private slot before the next native launch.
          console.warn('[provider-workflow] Codex key staging cleanup unavailable:', error instanceof Error ? error.name : 'UnknownError');
        }
      }
    }
  };
  return Object.assign((key: string) => save(key, async () => {}), { connect: save });
}

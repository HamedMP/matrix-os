import { bindClaudeNativeSignedOut, type ClaudeNativeSignedOut } from './claude-native-signed-out.js';
import { createClaudeNativeUsageReader } from './claude-native-usage.js';
import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { z } from 'zod/v4';
import type { CodexNativeAccountMetadata } from './codex-native-account-metadata.js';
import { bindNativeAccountMetadata } from './native-account-metadata-binding.js';
import { createNativeProviderWriterLease } from './native-provider-writer-lease.js';

/** CLI-owned subscription connection; never an inference/entitlement verdict. */
export interface ClaudeNativeAccountMetadata extends CodexNativeAccountMetadata { authMethod: 'terminal'; }
const StatusSchema = z.object({
  loggedIn: z.literal(true), authMethod: z.literal('claude.ai'), apiProvider: z.literal('firstParty'),
  email: z.email().max(120), orgId: z.string().min(1).max(160).optional(),
  subscriptionType: z.string().max(64).nullable().optional(), configDirectory: z.string().min(1).max(4096),
});
const SignedOutSchema = z.object({ loggedIn: z.literal(false), authMethod: z.literal('none'), apiProvider: z.literal('firstParty'), configDirectory: z.string().min(1).max(4096) });
function exactStatus(raw: unknown, home: string) {
  const result = StatusSchema.safeParse(raw);
  return result.success && resolve(result.data.configDirectory) === join(resolve(home), '.claude') ? result.data : null;
}
export function normalizeClaudeNativeAccountMetadata(raw: unknown, home: string, now: Date): ClaudeNativeAccountMetadata | null {
  const status = exactStatus(raw, home);
  if (!status) return null;
  const plans = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise' } as const;
  const planName = status.subscriptionType && Object.hasOwn(plans, status.subscriptionType)
    ? plans[status.subscriptionType as keyof typeof plans] : undefined;
  return { accountLabel: status.email, authMethod: 'terminal',
    connectionDetails: { email: status.email, ...(planName ? { planName } : {}) },
    checkedAt: now.toISOString(), staleAfter: new Date(+now + 30_000).toISOString() };
}
export type ClaudeNativeAccountMetadataReader = ((includeUsage?: boolean) => Promise<ClaudeNativeAccountMetadata | null>) & {
  readSignedOut?: () => Promise<ClaudeNativeSignedOut | null>;
  invalidate?: () => void;
};
type RunCommand = (executable: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string | Buffer }>;
const nativeCommand: RunCommand = async (executable, args, options) => await promisify(execFile)(executable, args, options);
/** Identity stays CLI-owned. Optional quota is a read-only server observation, never model admission. */
export function createClaudeNativeAccountMetadataReader(input: {
  executable: string; cwd: string; environment: Record<string, string>; now?: () => Date;
  timeoutMs?: number; runCommand?: RunCommand; assertProfileAvailable?: () => Promise<void>;
  usageReader?: ReturnType<typeof createClaudeNativeUsageReader>;
}): ClaudeNativeAccountMetadataReader {
  const home = resolve(input.cwd);
  if (!input.environment.HOME || resolve(input.environment.HOME) !== home) throw new Error('Native account runtime scope is required');
  const assertAvailable = input.assertProfileAvailable ?? (() => createNativeProviderWriterLease(home).assertAvailable('claude'));
  const environment = Object.fromEntries(Object.entries(input.environment).filter(([key]) =>
    ['HOME', 'MATRIX_HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'MATRIX_NODE_PREFIX'].includes(key)));
  // Match Settings login's default HOME resolution. An explicit override,
  // even HOME/.claude, moves the CLI's global .claude.json into that directory.
  const env = { ...environment, HOME: home };
  const now = input.now ?? (() => new Date());
  const timeout = Math.max(1, Math.min(input.timeoutMs ?? 3000, 4000));
  let readUsage = input.usageReader ?? createClaudeNativeUsageReader({homePath:home,now});
  let generation = 0;
  let pendingIdentity: Promise<ClaudeNativeAccountMetadata | null> | null = null;
  let pendingUsage: Promise<ClaudeNativeAccountMetadata | null> | null = null;
  // Native auth status is local and bounded. No cache survives an account change.
  const observe = async () => {
    await assertAvailable();
    let stdout: string | Buffer, failed = false;
    try {
      ({ stdout } = await (input.runCommand ?? nativeCommand)(input.executable, ['auth', 'status', '--json'], {
        cwd: home, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 8192, windowsHide: true,
      }));
    } catch (error: unknown) {
      // CLI auth status intentionally exits 1 for authoritative logged-out JSON.
      // Timeouts, other exit codes, truncated output and signals remain unknown.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 1
        || !('stdout' in error) || typeof error.stdout !== 'string'
        || !('stderr' in error) || error.stderr !== ''
        || ('signal' in error && error.signal != null) || ('killed' in error && error.killed === true)) throw error;
      stdout = error.stdout; failed = true;
    }
    await assertAvailable();
    if (Buffer.byteLength(stdout) > 8192) return null;
    const raw: unknown = JSON.parse(String(stdout));
    const signedOut = SignedOutSchema.safeParse(raw);
    if (signedOut.success && resolve(signedOut.data.configDirectory) === join(home, '.claude')) return signedOut.data;
    return failed ? null : exactStatus(raw, home);
  };
  const read = async (includeUsage: boolean) => {
      const capturedGeneration = generation;
      try {
        const status = await observe();
        if (!status?.loggedIn) return null;
        const metadata = normalizeClaudeNativeAccountMetadata(status, home, now());
        if (!metadata) return null;
        const principal = JSON.stringify({ email: status.email, orgId: status.orgId ?? null });
        const quota = includeUsage ? await readUsage() : null;
        if (quota) {
          const current = await observe();
          if (!current?.loggedIn || JSON.stringify({email:current.email,orgId:current.orgId ?? null}) !== principal) return null;
          // Quota freshness is independent of the CLI's current principal.
          if (await quota.isCurrent()) metadata.usage = quota.usage;
          metadata.checkedAt = now().toISOString();
          metadata.staleAfter = new Date(+now() + 30_000).toISOString();
        }
        if (capturedGeneration !== generation) return null;
        return bindNativeAccountMetadata(metadata, async () => {
          if (capturedGeneration !== generation) return false;
          const time = +now();
          if (Date.parse(metadata.checkedAt) > time || Date.parse(metadata.staleAfter) <= time) return false;
          const current = await observe();
          if (!current?.loggedIn || JSON.stringify({ email: current.email, orgId: current.orgId ?? null }) !== principal) return false;
          // Verification returns this same object to the projector. Remove an
          // invalid allowance before returning identity so stale usage cannot leak.
          if (metadata.usage && quota && !await quota.isCurrent()) delete metadata.usage;
          return capturedGeneration === generation && Date.parse(metadata.staleAfter) > +now();
        }, JSON.stringify({ home, principal })) as ClaudeNativeAccountMetadata;
      } catch (error: unknown) {
        console.warn('[provider-settings] Claude account status unavailable:', error instanceof Error ? error.name : 'UnknownError');
        return null;
      }
  };
  const reader: ClaudeNativeAccountMetadataReader = (includeUsage = false) => {
    // Completion only verifies identity; slow/missing quota must not fail sign-in.
    if (includeUsage) {
      if (!pendingUsage) {
        const request = read(true).finally(() => { if (pendingUsage === request) pendingUsage = null; });
        pendingUsage = request;
      }
      return pendingUsage;
    }
    if (!pendingIdentity) {
      const request = read(false).finally(() => { if (pendingIdentity === request) pendingIdentity = null; });
      pendingIdentity = request;
    }
    return pendingIdentity;
  };
  reader.readSignedOut = async () => {
    const capturedGeneration = generation;
    try {
      const status = await observe();
      if (!status || status.loggedIn || capturedGeneration !== generation) return null;
      return bindClaudeNativeSignedOut(home, now, async () => {
        const current = await observe();
        return capturedGeneration === generation && current !== null && !current.loggedIn;
      });
    } catch (error: unknown) {
      console.warn('[provider-settings] Claude sign-out observation unavailable:', error instanceof Error ? error.name : 'UnknownError');
      return null;
    }
  };
  reader.invalidate = () => {
    generation++; pendingIdentity = null; pendingUsage = null;
    // Recreate the default quota observer, dropping its credential-bound cache.
    // Injected readers retain responsibility for their own freshness contract.
    readUsage = input.usageReader ?? createClaudeNativeUsageReader({ homePath: home, now });
  };
  return reader;
}

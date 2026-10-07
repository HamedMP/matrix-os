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
type RunCommand = (executable: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string | Buffer }>;
const nativeCommand: RunCommand = async (executable, args, options) => await promisify(execFile)(executable, args, options);
/** Identity stays CLI-owned. Optional quota is a read-only server observation, never model admission. */
export function createClaudeNativeAccountMetadataReader(input: {
  executable: string; cwd: string; environment: Record<string, string>; now?: () => Date;
  timeoutMs?: number; runCommand?: RunCommand; assertProfileAvailable?: () => Promise<void>;
  usageReader?: ReturnType<typeof createClaudeNativeUsageReader>;
}): (includeUsage?: boolean) => Promise<ClaudeNativeAccountMetadata | null> {
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
  const readUsage = input.usageReader ?? createClaudeNativeUsageReader({homePath:home,now});
  let pendingIdentity: Promise<ClaudeNativeAccountMetadata | null> | null = null;
  let pendingUsage: Promise<ClaudeNativeAccountMetadata | null> | null = null;
  // Native auth status is local and bounded. No cache survives an account change.
  const observe = async () => {
    await assertAvailable();
    const { stdout } = await (input.runCommand ?? nativeCommand)(input.executable, ['auth', 'status', '--json'], {
      cwd: home, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 8192, windowsHide: true,
    });
    await assertAvailable();
    if (Buffer.byteLength(stdout) > 8192) return null;
    return exactStatus(JSON.parse(String(stdout)), home);
  };
  const read = async (includeUsage: boolean) => {
      try {
        const status = await observe();
        const metadata = status && normalizeClaudeNativeAccountMetadata(status, home, now());
        if (!metadata) return null;
        const principal = JSON.stringify({ email: status.email, orgId: status.orgId ?? null });
        const quota = includeUsage ? await readUsage() : null;
        if (quota) {
          const current = await observe();
          if (!current || JSON.stringify({email:current.email,orgId:current.orgId ?? null}) !== principal) return null;
          // Quota freshness is independent of the CLI's current principal.
          if (await quota.isCurrent()) metadata.usage = quota.usage;
          metadata.checkedAt = now().toISOString();
          metadata.staleAfter = new Date(+now() + 30_000).toISOString();
        }
        return bindNativeAccountMetadata(metadata, async () => {
          const time = +now();
          if (Date.parse(metadata.checkedAt) > time || Date.parse(metadata.staleAfter) <= time) return false;
          const current = await observe();
          if (!current || JSON.stringify({ email: current.email, orgId: current.orgId ?? null }) !== principal) return false;
          // Verification returns this same object to the projector. Remove an
          // invalid allowance before returning identity so stale usage cannot leak.
          if (metadata.usage && quota && !await quota.isCurrent()) delete metadata.usage;
          return Date.parse(metadata.staleAfter) > +now();
        }) as ClaudeNativeAccountMetadata;
      } catch (error: unknown) {
        console.warn('[provider-settings] Claude account status unavailable:', error instanceof Error ? error.name : 'UnknownError');
        return null;
      }
  };
  return (includeUsage = false) => {
    // Completion only verifies identity; slow/missing quota must not fail sign-in.
    if (includeUsage) {
      if (!pendingUsage) pendingUsage = read(true).finally(() => {pendingUsage = null;});
      return pendingUsage;
    }
    if (!pendingIdentity) pendingIdentity = read(false).finally(() => {pendingIdentity = null;});
    return pendingIdentity;
  };
}

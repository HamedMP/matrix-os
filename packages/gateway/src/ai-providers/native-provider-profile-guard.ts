import { join } from 'node:path';
import { z } from 'zod/v4';
import { ProviderConnectionAttemptSchema } from '@matrix-os/contracts';
import { readBoundedJsonFileWithIdentity } from '../bounded-json-file.js';
import { readSavedProviderSettingsConfiguration } from './provider-settings-persistence.js';
import { ProviderSettingsStoreError } from './provider-settings-errors.js';

export type NativeProviderProfile = 'codex' | 'claude';
type Admission = { kind: 'write' } | { kind: 'login'; recoveryKey: string; matchesLegacyReceipt?: (key: string, payloadHash: string) => boolean };
export interface NativeProviderProfileGuard {
  acquire(profile: NativeProviderProfile, admission: Admission): Promise<() => void>;
  run<T>(profile: NativeProviderProfile, admission: Admission, operation: () => Promise<T>): Promise<T>;
}
const ReceiptDocument = z.object({ version: z.literal(1), receipts: z.array(z.object({ key: z.string().min(1).max(128).optional(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), recoveryHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), superseded: z.boolean().optional(), archivedSessionName: z.string().min(1).max(128).optional(), attempt: ProviderConnectionAttemptSchema }).passthrough()).max(256) }).strict();

/** Shared API-path admission for the two singleton native credential profiles.
 * A receipt deadline is never evidence that its foreground process was reaped.
 */
export function createNativeProviderProfileGuard(options: {
  homePath: string;
  registry: {
    listProfileSessions?(): Promise<readonly { name: string; agent?: string }[]>;
    get(name: string): Promise<{ name: string; agent?: string }>;
    observeAgentLiveness(name: string, agent: NativeProviderProfile): Promise<'running' | 'stopped' | 'unknown'>;
  };
}): NativeProviderProfileGuard {
  if (!options.homePath || !options.registry?.get || !options.registry.observeAgentLiveness) throw new Error('Native profile admission dependencies required');
  const slots = { codex: { queued: 0 }, claude: { queued: 0 } };
  async function assertAvailable(profile: NativeProviderProfile, admission: Admission) {
    const documents = await Promise.all(['login-receipts.json', 'login-recovery.json'].map(async name => {
      const document = await readBoundedJsonFileWithIdentity(join(options.homePath, 'system/ai-providers', name), 1024 * 1024);
      return document ? ReceiptDocument.parse(document.value).receipts : [];
    }));
    const config = await readSavedProviderSettingsConfiguration(join(options.homePath, 'system/ai-providers/settings.json'));
    const managed = await options.registry.listProfileSessions?.() ?? [];
    if (managed.length > 64) throw new ProviderSettingsStoreError('lifecycle_unavailable', 503);
    const recoverable = new Set<string>(); // bounded to validated receipts plus one canonical name
    if (admission.kind === 'login') recoverable.add(`provider-auth-${BigInt(`0x${admission.recoveryKey}`).toString(36).padStart(50, '0')}`);
    const seen = new Set<string>(); // bounded to the 512 validated receipt entries in this invocation
    for (const receipt of documents.flat()) {
      if (receipt.attempt.action.kind !== 'open_terminal') continue;
      const name = receipt.archivedSessionName ?? receipt.attempt.action.terminalSessionId;
      if (seen.has(name)) continue;
      seen.add(name);
      let session: { name: string; agent?: string };
      try { session = await options.registry.get(name); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'session_not_found') continue;
        throw new ProviderSettingsStoreError('lifecycle_unavailable', 503);
      }
      const configured = config?.harnesses.find(h => h.id === receipt.attempt.harnessInstanceId)?.harness;
      const identity = session.agent ?? configured ?? (receipt.attempt.harnessInstanceId === 'harness_codex' ? 'codex' : receipt.attempt.harnessInstanceId === 'harness_claude_code' ? 'claude' : undefined);
      if (identity && identity !== profile) continue;
      const liveness = await options.registry.observeAgentLiveness(name, profile);
      if (liveness === 'stopped') continue;
      // Exact canonical replay/adoption may read the already-running session.
      // No generic writer and no different instance/account may replace it.
      if (identity === profile && admission.kind === 'login' && (receipt.recoveryHash === admission.recoveryKey || receipt.recoveryHash === undefined && receipt.key && receipt.payloadHash && name === `provider-login-${profile}-${receipt.payloadHash.slice(0, 16)}` && admission.matchesLegacyReceipt?.(receipt.key, receipt.payloadHash))) { recoverable.add(name); continue; }
      throw new ProviderSettingsStoreError('lifecycle_unavailable', 503);
    }
    // Registry discovery also protects receipt-evicted historical sessions.
    for (const session of managed) {
      if (session.agent && session.agent !== profile) continue;
      if (await options.registry.observeAgentLiveness(session.name, profile) === 'stopped') continue;
      if (admission.kind === 'login' && recoverable.has(session.name)) continue;
      throw new ProviderSettingsStoreError('lifecycle_unavailable', 503);
    }
  }
  async function acquire(profile: NativeProviderProfile, admission: Admission): Promise<() => void> {
    const slot = slots[profile];
    if (!slot || slot.queued > 0) throw new ProviderSettingsStoreError('lifecycle_unavailable', 503);
    slot.queued = 1;
    try { await assertAvailable(profile, admission); }
    catch (error) { slot.queued = 0; throw error; }
    let released = false;
    return () => { if (!released) { released = true; slot.queued = 0; } };
  }
  return {
    acquire,
    async run<T>(profile: NativeProviderProfile, admission: Admission, operation: () => Promise<T>): Promise<T> {
      const release = await acquire(profile, admission);
      try { return await operation(); } finally { release(); }
    },
  };
}

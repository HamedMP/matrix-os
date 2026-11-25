import { join } from "node:path";
import type { CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";
import { nativeAccountLegacyPrincipalFingerprint, nativeAccountPrincipalFingerprint } from "./native-account-metadata-binding.js";
import { writeProviderJsonAtomic } from "./provider-settings-persistence.js";
import { CODEX_CONSENT_ALIAS_PATH, readCodexConsentAlias, type CodexConsentAlias } from "../coding-agents/codex-consent-alias.mjs";

// One write queue per Matrix home: writeProviderJsonAtomic uses a fixed temp
// name, so overlapping admissions must not write concurrently. Entries are
// removed when their queue drains; a gateway serves one home.
const MAX_HOME_QUEUES = 16;
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(homePath: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(homePath);
  if (!previous && queues.size >= MAX_HOME_QUEUES) throw new Error("Codex consent upgrade queue is full");
  // `previous` is always a settled-safe tail; the caller receives `run`'s error.
  const run = (previous ?? Promise.resolve()).then(task);
  const tail = run.then(() => undefined, (error: unknown) => {
    console.warn("[native-codex] Consent upgrade write failed:", error instanceof Error ? error.name : "UnknownError");
  });
  queues.set(homePath, tail);
  try { return await run; }
  finally { if (queues.get(homePath) === tail) queues.delete(homePath); }
}

/**
 * Shared same-account consent upgrade (ENG-523), used by every admission entry
 * point. Only a verified observation whose legacy token-bound generation equals
 * the saved consent qualifies: that is the exact pre-upgrade rule, so this never
 * admits a different account. The saved row is never rewritten.
 * Callers pass metadata they have already verified with a fresh private proof.
 */
export async function upgradeCodexConsentAlias(homePath: string, saved: string | undefined,
  metadata: CodexNativeAccountMetadata): Promise<CodexConsentAlias | null> {
  if (!saved || metadata.authMethod !== "terminal") return null;
  const durable = nativeAccountPrincipalFingerprint(metadata);
  if (!durable || durable === saved || nativeAccountLegacyPrincipalFingerprint(metadata) !== saved) return null;
  const alias: CodexConsentAlias = { version: 1, saved, durable };
  return await serialized(homePath, async () => {
    const current = await readCodexConsentAlias(homePath);
    if (current?.saved === saved && current.durable === durable) return current;
    await writeProviderJsonAtomic(join(homePath, CODEX_CONSENT_ALIAS_PATH), alias);
    return alias;
  });
}

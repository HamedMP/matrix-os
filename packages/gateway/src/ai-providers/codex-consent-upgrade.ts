import { join } from "node:path";
import type { CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";
import { nativeAccountLegacyPrincipalFingerprint, nativeAccountPrincipalFingerprint } from "./native-account-metadata-binding.js";
import { writeProviderJsonAtomic } from "./provider-settings-persistence.js";
import { CODEX_CONSENT_ALIAS_PATH, type CodexConsentAlias } from "../coding-agents/codex-consent-alias.mjs";

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
  await writeProviderJsonAtomic(join(homePath, CODEX_CONSENT_ALIAS_PATH), alias);
  return alias;
}

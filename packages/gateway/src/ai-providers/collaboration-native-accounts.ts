import { createHash } from "node:crypto";
import type { AiProviderSnapshotV3, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { ProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import type { ClaudeNativeAccountMetadata, ClaudeNativeAccountMetadataReader } from "./claude-native-account-metadata.js";
import type { CodexNativeAccountMetadata, CodexNativeAccountMetadataReader } from "./codex-native-account-metadata.js";
import type { CollaborationChatProviderRoute } from "./snapshot-read-options.js";
import { nativeAccountPrincipalFingerprint, verifyNativeAccountMetadata } from "./native-account-metadata-binding.js";

/** Admission needs a fresh principal proof, not quota or an unrelated account observation. */
export async function readCollaborationNativeAccounts(input: {
  config: Pick<ProviderSettingsConfiguration, "harnesses">;
  chatRoute?: CollaborationChatProviderRoute;
  codex?: CodexNativeAccountMetadataReader;
  claude?: ClaudeNativeAccountMetadataReader;
}): Promise<{ codexMetadata: CodexNativeAccountMetadata | null; claudeMetadata: ClaudeNativeAccountMetadata | null }> {
  let codexMetadata: CodexNativeAccountMetadata | null = null;
  let claudeMetadata: ClaudeNativeAccountMetadata | null = null;
  const codex = (!input.chatRoute || input.chatRoute.driverKind === "codex")
    && input.config.harnesses.some(h => h.harness === "codex" && h.enabled && h.accessSourceId === "owner_openai_profile");
  const claude = (!input.chatRoute || input.chatRoute.driverKind === "claude_code")
    && input.config.harnesses.some(h => h.harness === "claude" && h.enabled && h.accessSourceId === "owner_claude_profile");
  try {
    if (codex) codexMetadata = await verifyNativeAccountMetadata(await input.codex?.({ includeUsage: false }));
    if (claude) claudeMetadata = await verifyNativeAccountMetadata(await input.claude?.(false));
  } catch (error: unknown) {
    console.warn("[provider-settings] Native collaboration route unavailable:", error instanceof Error ? error.name : "UnknownError");
  }
  return { codexMetadata, claudeMetadata };
}

/** Promote only the exact consent-bound native Codex route into canonical execution truth. */
export function qualifyNativeCodexCollaborationRoute(
  canonical: AiProviderSnapshotV3,
  config: ProviderSettingsConfiguration,
  projected?: ProviderSettingsSnapshot,
): AiProviderSnapshotV3 {
  const saved = config.harnesses.find((harness) => harness.harness === "codex" && harness.enabled
    && harness.accessSourceId === "owner_openai_profile" && harness.selectedAccountId !== null);
  if (!saved) return canonical;
  const source = canonical.accessSources.find((candidate) => candidate.id === saved.accessSourceId
    && candidate.fundingKind === "owner_account");
  const harness = projected?.harnesses.find((candidate) => candidate.id === saved.id && candidate.harness === "codex");
  const projectedSource = projected?.accessSources.find((candidate) => candidate.id === saved.accessSourceId);
  const candidates = canonical.instances.filter((instance) => instance.driverId === saved.driverId
    && instance.accessSourceId === saved.accessSourceId && instance.accountId === saved.selectedAccountId
    && instance.modelIds.includes(saved.route.modelId));
  if (!source || candidates.length !== 1 || harness?.enabled !== true || harness.authState !== "authenticated"
    || harness.accessSourceId !== saved.accessSourceId || harness.selectedAccountId !== saved.selectedAccountId
    || harness.route.providerId !== saved.route.providerId || harness.route.modelId !== saved.route.modelId
    || projectedSource?.readiness.state !== "ready" || !saved.nativeAccountGeneration
    || saved.nativeAccountConsentRevision === undefined) return canonical;
  const readiness = projectedSource.readiness;
  // The canonical IDs remain stable when one native Codex principal replaces
  // another. Bind that consented principal generation into execution authority
  // without exposing the saved fingerprint or treating cosmetic revisions as a
  // route change.
  const nativeAuthorityVersion = createHash("sha256")
    .update(`${source.policyVersion}\0${saved.nativeAccountGeneration}`)
    .digest("hex");
  return {
    ...canonical,
    accessSources: canonical.accessSources.map((candidate) => candidate.id === source.id ? {
      ...candidate,
      policyVersion: nativeAuthorityVersion,
      state: readiness.state,
      checkedAt: readiness.checkedAt,
      staleAfter: readiness.staleAfter,
      action: readiness.action,
      safeReason: readiness.safeReason,
    } : candidate),
    instances: canonical.instances.map((instance) => instance.id === candidates[0]!.id ? {
      ...instance,
      readiness,
      defaultModelId: saved.route.modelId,
    } : instance),
  };
}

/** Promote only the exact saved Claude subscription backed by a fresh native principal proof. */
export function qualifyNativeClaudeCollaborationRoute(
  canonical: AiProviderSnapshotV3,
  config: ProviderSettingsConfiguration,
  projected?: ProviderSettingsSnapshot,
  metadata?: ClaudeNativeAccountMetadata | null,
): AiProviderSnapshotV3 {
  const saved = config.harnesses.find((harness) => harness.harness === "claude" && harness.enabled
    && harness.accessSourceId === "owner_claude_profile" && harness.selectedAccountId !== null);
  if (!saved || !metadata) return canonical;
  const source = canonical.accessSources.find((candidate) => candidate.id === saved.accessSourceId
    && candidate.vendor === "anthropic" && candidate.fundingKind === "owner_account");
  const harness = projected?.harnesses.find((candidate) => candidate.id === saved.id && candidate.harness === "claude");
  const candidates = canonical.instances.filter((instance) => instance.driverId === saved.driverId
    && instance.vendor === "anthropic" && instance.accessSourceId === saved.accessSourceId
    && instance.accountId === saved.selectedAccountId && instance.modelIds.includes(saved.route.modelId));
  const nativeAccountGeneration = nativeAccountPrincipalFingerprint(metadata);
  if (!source || candidates.length !== 1 || harness?.enabled !== true || harness.authState !== "authenticated"
    || harness.accessSourceId !== saved.accessSourceId || harness.selectedAccountId !== saved.selectedAccountId
    || harness.route.providerId !== saved.route.providerId || harness.route.modelId !== saved.route.modelId
    || !nativeAccountGeneration) return canonical;
  const readiness = {
    state: "ready" as const,
    checkedAt: metadata.checkedAt,
    staleAfter: metadata.staleAfter,
    action: "none" as const,
    safeReason: null,
  };
  const nativeAuthorityVersion = createHash("sha256")
    .update(`${source.policyVersion}\0${nativeAccountGeneration}`)
    .digest("hex");
  return {
    ...canonical,
    accessSources: canonical.accessSources.map((candidate) => candidate.id === source.id ? {
      ...candidate,
      policyVersion: nativeAuthorityVersion,
      state: readiness.state,
      checkedAt: readiness.checkedAt,
      staleAfter: readiness.staleAfter,
      action: readiness.action,
      safeReason: readiness.safeReason,
    } : candidate),
    instances: canonical.instances.map((instance) => instance.id === candidates[0]!.id ? {
      ...instance,
      readiness,
      defaultModelId: saved.route.modelId,
    } : instance),
  };
}

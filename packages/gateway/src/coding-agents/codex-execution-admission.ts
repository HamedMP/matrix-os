import { isSessionStartClean, isSessionStopConfirmed } from "./session-start-cleanup-proof.js";
import { nativeCodexConfigurationFingerprint } from "./native-codex-configuration-fingerprint.mjs";
import { createCodexExecutionSessions } from "./codex-execution-sessions.js";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readSavedProviderSettingsConfiguration } from "../ai-providers/provider-settings-persistence.js";
import { nativeAccountPrincipalFingerprint, verifyNativeAccountMetadata } from "../ai-providers/native-account-metadata-binding.js";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { CodexNativeAccountMetadata } from "../ai-providers/codex-native-account-metadata.js";
import { readOwnerOpenRouterKey } from "../ai-providers/owner-openrouter-key.js";
import { OPENROUTER_CODEX_MODEL_IDS } from "../ai-providers/model-catalog.js";
import type { OpenRouterCodexLaunch } from "./openrouter-codex-launch-policy.js";
export interface CodexExecutionAdmission {
  start(userId: string, sessionId?: string): Promise<string | undefined>;
  validate(userId: string, binding?: string, sessionId?: string): Promise<void>;
  validateLaunch(userId: string, sessionId: string): Promise<{
    expectedPrincipalFingerprint: string; expectedConsentRevision: number; expectedConfigurationFingerprint: string;
    expectedHarnessInstanceId: string; expectedAccountId: string;
  } | Omit<OpenRouterCodexLaunch, "codexHome"> | undefined>;
  prepareRevocation(): Promise<() => Promise<void>>;
  releaseStoppedSession(userId: string, sessionId: string, proof: unknown): Promise<void>;
  releaseFailedStart(userId: string, sessionId: string, binding: string | undefined, result: unknown): Promise<void>;
}
export interface CodexExecutionAdmissionOptions {
  homePath: string;
  stopSession?(sessionId: string): Promise<void>;
  assertProfileAvailable?(): Promise<void>;
  getSnapshot(): Promise<ProviderSettingsSnapshot>;
  readNativeAccount(): Promise<CodexNativeAccountMetadata | null>;
  isOwner(userId: string): boolean | Promise<boolean>;
}
const UNAVAILABLE = "Selected Codex account is unavailable";
type NativeIntent = {
  kind: "native";
  binding: string;
  principal: string;
  consentRevision: number;
  configurationFingerprint: string;
  harnessInstanceId: string;
  accountId: string;
};
type OpenRouterIntent = Omit<OpenRouterCodexLaunch, "codexHome"> & { binding: string };

/** Persisted generation references never authorize without a fresh private native proof. */
export function createCodexExecutionAdmission(options: CodexExecutionAdmissionOptions): CodexExecutionAdmission {
  const path = join(resolve(options.homePath), "system/ai-providers/settings.json");
  const sessions = createCodexExecutionSessions(resolve(options.homePath), options.stopSession);
  const reject = (): never => { throw new Error(UNAVAILABLE); };
  async function current(userId: string) {
    if (!await options.isOwner(userId)) reject();
    // Do not wait on the Settings lock while its revocation is stopping children.
    await sessions.assertOpen();
    const config = await readSavedProviderSettingsConfiguration(path);
    const rows = config?.harnesses.filter(row => row.harness === "codex") ?? [];
    if (!rows.length) {
      // Legacy ambient ChatGPT credentials are not consent. Only an independently
      // verified existing API-key profile may keep its ordinary pre-Settings path.
      await sessions.assertOpen();
      await options.assertProfileAvailable?.();
      const metadata = await verifyNativeAccountMetadata(await options.readNativeAccount());
      if (!metadata || metadata.authMethod !== "api_key"
        || !(Date.parse(metadata.checkedAt) <= Date.now() && Date.parse(metadata.staleAfter) > Date.now())) reject();
      await options.assertProfileAvailable?.();
      await sessions.assertOpen();
      const latest = await readSavedProviderSettingsConfiguration(path);
      if ((latest?.harnesses.filter(row => row.harness === "codex").length ?? 0) !== 0) reject();
      return undefined;
    }
    if (rows.length !== 1 || !rows[0]!.enabled) reject();
    const row = rows[0]!;
    if (row.route.kind !== "fixed") reject();
    const snapshot = await options.getSnapshot();
    if (snapshot.access.mode !== "writable" || snapshot.revision !== config!.revision) reject();
    const source = snapshot.accessSources.find(source => source.id === row.accessSourceId);
    const account = snapshot.accounts.find(account => account.id === row.selectedAccountId);
    if (row.route.providerId === "openrouter") {
      if (row.accessSourceId !== "owner_openrouter" || row.selectedAccountId !== "owner_openrouter"
        || !OPENROUTER_CODEX_MODEL_IDS.includes(row.route.modelId as (typeof OPENROUTER_CODEX_MODEL_IDS)[number])
        || !row.credentialGeneration || !source
        || source.id !== "owner_openrouter" || source.kind !== "provider_account"
        || source.providerId !== "openrouter" || source.fundingKind !== "owner_api_key"
        || source.accountId !== row.selectedAccountId
        || source.credentialGeneration !== row.credentialGeneration
        || source.readiness.state !== "ready"
        || !source.eligibleModelIds.includes(row.route.modelId)
        || !account || account.providerId !== "openrouter" || account.accessSourceId !== source.id
        || account.authMethod !== "api_key" || account.authState !== "authenticated") reject();
      const credential = await readOwnerOpenRouterKey(options.homePath);
      if (!credential.key || credential.credentialGeneration !== row.credentialGeneration) reject();
      await sessions.assertOpen();
      const [latest, currentCredential] = await Promise.all([
        readSavedProviderSettingsConfiguration(path),
        readOwnerOpenRouterKey(options.homePath),
      ]);
      const latestRow = latest?.harnesses.filter(candidate => candidate.harness === "codex")[0];
      if (!latest || latest.revision !== config!.revision || latest.harnesses.filter(candidate => candidate.harness === "codex").length !== 1
        || !latestRow || latestRow.id !== row.id || !latestRow.enabled
        || latestRow.accessSourceId !== row.accessSourceId || latestRow.selectedAccountId !== row.selectedAccountId
        || latestRow.credentialGeneration !== row.credentialGeneration
        || latestRow.route.kind !== "fixed" || latestRow.route.providerId !== "openrouter"
        || latestRow.route.modelId !== row.route.modelId
        || currentCredential.key !== credential.key
        || currentCredential.credentialGeneration !== row.credentialGeneration) reject();
      const apiKey = currentCredential.key!;
      const credentialGeneration = row.credentialGeneration!;
      const accountId = row.selectedAccountId!;
      if (!apiKey || !credentialGeneration || !accountId) reject();
      const binding = createHash("sha256").update(JSON.stringify({
        owner: userId,
        computer: resolve(options.homePath),
        harnessInstanceId: row.id,
        accountId,
        credentialGeneration,
        model: row.route.modelId,
      })).digest("hex");
      return {
        kind: "openrouter",
        binding,
        apiKey,
        credentialGeneration,
        model: row.route.modelId as (typeof OPENROUTER_CODEX_MODEL_IDS)[number],
        expectedHarnessInstanceId: row.id,
        expectedAccountId: accountId,
      } satisfies OpenRouterIntent;
    }
    if (row.route.providerId !== "openai") reject();
    if (!source || source.kind !== "provider_account" || source.providerId !== "openai"
      || source!.accountId !== row.selectedAccountId || !account || account!.providerId !== "openai"
      || account!.accessSourceId !== source!.id) reject();
    if (source!.fundingKind === "owner_api_key" && account!.authMethod === "api_key") {
      await sessions.assertOpen();
      return undefined;
    }
    if (source!.id !== "owner_openai_profile" || source!.fundingKind !== "owner_account" || account!.authMethod !== "terminal"
      || account!.authState !== "authenticated") reject();
    await sessions.assertOpen();
    await options.assertProfileAvailable?.();
    const metadata = await verifyNativeAccountMetadata(await options.readNativeAccount());
    if (!metadata || metadata.authMethod !== "terminal"
      || !(Date.parse(metadata.checkedAt) <= Date.now() && Date.parse(metadata.staleAfter) > Date.now())) reject();
    // Re-read after asynchronous proof so an intervening Settings write cannot authorize dispatch.
    await options.assertProfileAvailable?.();
    await sessions.assertOpen();
    const latest = await readSavedProviderSettingsConfiguration(path);
    if (!latest || latest.revision !== config!.revision) reject();
    const principal = nativeAccountPrincipalFingerprint(metadata!);
    if (!principal || row.nativeAccountGeneration !== principal || row.nativeAccountConsentRevision === undefined) reject();
    const configurationFingerprint = nativeCodexConfigurationFingerprint(row);
    const binding = createHash("sha256").update(JSON.stringify({
      owner: userId, computer: resolve(options.homePath), configurationFingerprint, principal,
    })).digest("hex");
    return { kind: "native", binding, principal: principal!, consentRevision: row.nativeAccountConsentRevision!, configurationFingerprint, harnessInstanceId: row.id, accountId: row.selectedAccountId! } satisfies NativeIntent;
  }
  async function validate(userId: string, binding?: string, sessionId?: string) {
    const value = await current(userId);
    if (value?.binding !== binding) {
      reject();
    }
    await sessions.register(userId, sessionId, value?.binding ?? null);
    return value;
  }
  return {
    prepareRevocation: sessions.prepareRevocation,
    async releaseStoppedSession(userId, sessionId, proof) {
      if (!isSessionStopConfirmed(proof, userId, sessionId)) return;
      await sessions.releaseCleanFailure(userId, sessionId);
    },
    async releaseFailedStart(userId, sessionId, binding, result) {
      if (!isSessionStartClean(result, userId, sessionId)) return;
      await sessions.releaseCleanFailure(userId, sessionId, binding ?? null);
    },
    async start(userId, sessionId) {
      const value = await current(userId);
      await sessions.register(userId, sessionId, value?.binding ?? null);
      return value?.binding;
    },
    async validate(userId, binding, sessionId) { await validate(userId, binding, sessionId); },
    async validateLaunch(userId, sessionId) {
      const prior = await sessions.get(sessionId);
      if (prior && prior.userId !== userId) reject();
      const value = await validate(userId, prior?.binding ?? undefined, sessionId);
      if (!value) return undefined;
      if (value.kind === "openrouter") {
        const { binding: _binding, ...launch } = value;
        return launch;
      }
      return { expectedPrincipalFingerprint: value.principal, expectedConsentRevision: value.consentRevision,
        expectedHarnessInstanceId: value.harnessInstanceId, expectedAccountId: value.accountId, expectedConfigurationFingerprint: value.configurationFingerprint };
    },
  };
}

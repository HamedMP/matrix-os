import { isSessionStartClean, isSessionStopConfirmed } from "./session-start-cleanup-proof.js";
import { nativeCodexConfigurationFingerprint } from "./native-codex-configuration-fingerprint.mjs";
import { createCodexExecutionSessions } from "./codex-execution-sessions.js";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readSavedProviderSettingsConfiguration } from "../ai-providers/provider-settings-persistence.js";
import { nativeAccountPrincipalFingerprint, verifyNativeAccountMetadata } from "../ai-providers/native-account-metadata-binding.js";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { CodexNativeAccountMetadata } from "../ai-providers/codex-native-account-metadata.js";
export interface CodexExecutionAdmission {
  start(userId: string, sessionId?: string): Promise<string | undefined>;
  validate(userId: string, binding?: string, sessionId?: string): Promise<void>;
  validateLaunch(userId: string, sessionId: string): Promise<{
    expectedPrincipalFingerprint: string; expectedConsentRevision: number; expectedConfigurationFingerprint: string;
    expectedHarnessInstanceId: string; expectedAccountId: string;
  } | undefined>;
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
    if (row.route.kind !== "fixed" || row.route.providerId !== "openai") reject();
    const snapshot = await options.getSnapshot();
    if (snapshot.access.mode !== "writable" || snapshot.revision !== config!.revision) reject();
    const source = snapshot.accessSources.find(source => source.id === row.accessSourceId);
    const account = snapshot.accounts.find(account => account.id === row.selectedAccountId);
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
    return { binding, principal: principal!, consentRevision: row.nativeAccountConsentRevision!, configurationFingerprint, harnessInstanceId: row.id, accountId: row.selectedAccountId! };
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
      return value ? { expectedPrincipalFingerprint: value.principal, expectedConsentRevision: value.consentRevision,
        expectedHarnessInstanceId: value.harnessInstanceId, expectedAccountId: value.accountId, expectedConfigurationFingerprint: value.configurationFingerprint } : undefined;
    },
  };
}

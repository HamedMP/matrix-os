import { isSessionStartClean, isSessionStopConfirmed } from "./session-start-cleanup-proof.js";
import { timeChatSendStage } from "../chat/send-timing.js";
import { nativeCodexConfigurationFingerprint } from "./native-codex-configuration-fingerprint.mjs";
import { createCodexExecutionSessions } from "./codex-execution-sessions.js";
import { boundedOperation } from "../bounded-operation.js";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readSavedProviderSettingsConfiguration } from "../ai-providers/provider-settings-persistence.js";
import { nativeAccountPrincipalFingerprint, verifyNativeAccountMetadata } from "../ai-providers/native-account-metadata-binding.js";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { CodexNativeAccountMetadata } from "../ai-providers/codex-native-account-metadata.js";
export interface CodexExecutionAdmission {
  start(userId: string, sessionId?: string): Promise<string | undefined>;
  validate(userId: string, binding?: string, sessionId?: string): Promise<void>;
  renewStoppedSession(userId: string, previousBinding: string, sessionId: string,
    proveStopped: (signal: AbortSignal) => Promise<boolean>): Promise<string>;
  validateLaunch(userId: string, sessionId: string): Promise<{
    expectedPrincipalFingerprint: string; expectedConsentRevision: number; expectedConfigurationFingerprint: string;
    expectedHarnessInstanceId: string; expectedAccountId: string;
  } | undefined>;
  prepareRevocation(): Promise<() => Promise<void>>;
  releaseStoppedSession(userId: string, sessionId: string, proof: unknown): Promise<void>;
  releaseFailedStart(userId: string, sessionId: string, binding: string | undefined, result: unknown): Promise<void>;
  /** Full check that also mints a short-lived same-send receipt. */
  startWithReceipt?(userId: string, sessionId?: string): Promise<{ binding: string | undefined; receipt: CodexAdmissionReceipt }>;
  validateWithReceipt?(userId: string, binding: string | undefined, sessionId?: string): Promise<CodexAdmissionReceipt>;
  /**
   * Re-check within the same send after an async step (watch): owner, open
   * revocation gate, unchanged saved consent row and revision, and a fresh
   * verified native principal equal to the receipt's. Skips only re-projecting
   * the Settings snapshot. Unknown, foreign, or expired receipts run the full check.
   */
  confirm?(userId: string, receipt: CodexAdmissionReceipt, sessionId?: string): Promise<void>;
}
/** Opaque; only receipts minted by the same admission instance are honored. */
export type CodexAdmissionReceipt = { readonly binding: string | undefined };
const RECEIPT_TTL_MS = 30_000;
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
  const current = (userId: string) => timeChatSendStage("codex_execution_admission", () => currentUntimed(userId));
  async function currentUntimed(userId: string) {
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
    return { revision: config!.revision, binding, principal: principal!, consentRevision: row.nativeAccountConsentRevision!, configurationFingerprint, harnessInstanceId: row.id, accountId: row.selectedAccountId! };
  }
  async function validate(userId: string, binding?: string, sessionId?: string) {
    const value = await current(userId);
    if (value?.binding !== binding) {
      reject();
    }
    await sessions.register(userId, sessionId, value?.binding ?? null);
    return value;
  }
  // Receipt facts stay private to this instance; the WeakMap is bounded by live receipts.
  const receipts = new WeakMap<object, { userId: string; binding: string; principal: string; revision: number;
    configurationFingerprint: string; issuedAt: number }>();
  function mint(userId: string, value: Awaited<ReturnType<typeof current>>, binding: string | undefined): CodexAdmissionReceipt {
    const receipt = Object.freeze({ binding });
    if (value) receipts.set(receipt, { userId, binding: value.binding, principal: value.principal, revision: value.revision,
      configurationFingerprint: value.configurationFingerprint, issuedAt: Date.now() });
    return receipt;
  }
  async function confirm(userId: string, receipt: CodexAdmissionReceipt, sessionId?: string) {
    const facts = receipt && typeof receipt === "object" ? receipts.get(receipt) : undefined;
    const age = facts ? Date.now() - facts.issuedAt : Infinity;
    if (!facts || facts.userId !== userId || age < 0 || age >= RECEIPT_TTL_MS) {
      await validate(userId, receipt?.binding, sessionId);
      return;
    }
    await timeChatSendStage("codex_execution_confirm", async () => {
      if (!await options.isOwner(userId)) reject();
      await sessions.assertOpen();
      const config = await readSavedProviderSettingsConfiguration(path);
      const rows = config?.harnesses.filter(row => row.harness === "codex") ?? [];
      const row = rows[0];
      if (!config || config.revision !== facts.revision || rows.length !== 1 || !row!.enabled
        || nativeCodexConfigurationFingerprint(row!) !== facts.configurationFingerprint
        || row!.nativeAccountGeneration !== facts.principal) reject();
      await options.assertProfileAvailable?.();
      const metadata = await verifyNativeAccountMetadata(await options.readNativeAccount());
      if (!metadata || metadata.authMethod !== "terminal"
        || !(Date.parse(metadata.checkedAt) <= Date.now() && Date.parse(metadata.staleAfter) > Date.now())
        || nativeAccountPrincipalFingerprint(metadata) !== facts.principal) reject();
      await options.assertProfileAvailable?.();
      await sessions.assertOpen();
      const latest = await readSavedProviderSettingsConfiguration(path);
      if (!latest || latest.revision !== facts.revision) reject();
      await sessions.register(userId, sessionId, facts.binding);
    });
  }
  return {
    confirm,
    async startWithReceipt(userId, sessionId) {
      const value = await current(userId);
      await sessions.register(userId, sessionId, value?.binding ?? null);
      return { binding: value?.binding, receipt: mint(userId, value, value?.binding) };
    },
    async validateWithReceipt(userId, binding, sessionId) {
      const value = await validate(userId, binding, sessionId);
      return mint(userId, value, binding);
    },
    prepareRevocation: sessions.prepareRevocation,
    async renewStoppedSession(userId, previousBinding, sessionId, proveStopped) {
      if (!/^[a-f0-9]{64}$/.test(previousBinding)) reject();
      const candidate = await current(userId);
      if (!candidate) throw new Error(UNAVAILABLE);
      if (candidate.binding === previousBinding) reject();
      const prior = await sessions.get(sessionId);
      // An old registration may still own a live child. Only completed
      // revocation or a retry of this exact renewal can advance it.
      if (prior && (prior.userId !== userId || prior.binding !== candidate.binding)) reject();
      let stopped = false;
      try {
        stopped = await boundedOperation(proveStopped, 5_000);
      } catch (error: unknown) {
        console.warn("[native-codex] Stopped-session proof failed:", error instanceof Error ? error.name : "UnknownError");
      }
      if (!stopped) reject();
      const latest = await current(userId);
      if (!latest) throw new Error(UNAVAILABLE);
      if (latest.binding !== candidate.binding) reject();
      await sessions.register(userId, sessionId, latest.binding);
      return latest.binding;
    },
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

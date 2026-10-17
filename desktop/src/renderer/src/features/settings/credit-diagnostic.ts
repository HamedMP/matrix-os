import { ProviderSettingsSnapshotSchema, readRunningCommit, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { gatewayChatAvailableMicrousd } from "@matrix-os/ui";
import { z } from "zod/v4";

const Target = z.object({
  machineId: z.uuid(), runtimeSlot: z.string().regex(/^pv-[a-z0-9-]{1,100}$/),
  backendSource: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type DesktopCreditDiagnosticTarget = z.infer<typeof Target>;
/** Local QA build configuration; omitted or invalid configuration leaves the disclosure off. */
export function desktopCreditDiagnosticTarget(env: Record<string, unknown>): DesktopCreditDiagnosticTarget | undefined {
  const parsed = Target.safeParse({ machineId: env.VITE_MATRIX_CREDIT_DIAGNOSTIC_MACHINE_ID,
    runtimeSlot: env.VITE_MATRIX_CREDIT_DIAGNOSTIC_RUNTIME, backendSource: env.VITE_MATRIX_CREDIT_DIAGNOSTIC_BACKEND_SOURCE });
  return parsed.success ? parsed.data : undefined;
}
export class DesktopCreditDiagnosticError extends Error {
  constructor(readonly code: "invalid_target" | "foreign_runtime" | "source_mismatch" | "identity_changed" | "unavailable") {
    super("Credit diagnostic unavailable");
  }
}
export interface DesktopCreditDiagnosticContext {
  identityKey: string;
  handle: string | null;
  runtimeSlot: string;
  generation: number;
  authGeneration: number;
  snapshot: ProviderSettingsSnapshot;
  selectedHarnessId: string | null;
}
const SystemRuntime = z.object({
  runtime: z.object({ machineId: z.uuid(), runtimeSlot: z.string().min(1).max(128), handle: z.string().min(1).max(128) }),
  runningVersion: z.string().max(128).optional(),
});
const canonicalVersion = /^v\d{4}\.\d{2}\.\d{2}-(?:pr\d+-\d+-\d+-[a-f0-9]{7,40}|main-[a-f0-9]{7,40}-[a-f0-9]{8})$/;

/** Same-session corroboration of an accepted snapshot, not signed downstream ledger identity. */
export async function readDesktopCreditDiagnostic(input: {
  api: { get(path: string, options: { maxBytes: number; signal: AbortSignal; timeoutMs: number }): Promise<unknown> };
  target: DesktopCreditDiagnosticTarget;
  signal: AbortSignal;
  getContext(): DesktopCreditDiagnosticContext;
}) {
  const parsed = Target.safeParse(input.target);
  if (!parsed.success) throw new DesktopCreditDiagnosticError("invalid_target");
  const target = parsed.data;
  const captured = { ...input.getContext() };
  const check = () => {
    input.signal.throwIfAborted();
    const current = input.getContext();
    if (captured.runtimeSlot !== target.runtimeSlot || current.runtimeSlot !== captured.runtimeSlot
      || current.identityKey !== captured.identityKey || current.handle !== captured.handle
      || current.generation !== captured.generation || current.authGeneration !== captured.authGeneration
      || current.snapshot !== captured.snapshot || current.selectedHarnessId !== captured.selectedHarnessId) {
      throw new DesktopCreditDiagnosticError("identity_changed");
    }
  };
  const system = async () => {
    check();
    const value = await input.api.get("/api/system/info", { maxBytes: 64 * 1024, signal: input.signal, timeoutMs: 10_000 });
    check();
    const observed = SystemRuntime.safeParse(value);
    if (!observed.success || observed.data.runtime.machineId !== target.machineId
      || observed.data.runtime.handle !== captured.handle || observed.data.runtime.runtimeSlot !== captured.runtimeSlot) {
      throw new DesktopCreditDiagnosticError("foreign_runtime");
    }
    if (readRunningCommit(value) !== target.backendSource) throw new DesktopCreditDiagnosticError("source_mismatch");
    const version = observed.data.runningVersion;
    return version && canonicalVersion.test(version) ? version : null;
  };
  try {
    const before = await system();
    const projection = await projectDesktopCreditDiagnostic(captured.snapshot, Date.now(), check);
    check();
    const after = await system();
    if (after !== before) throw new DesktopCreditDiagnosticError("source_mismatch");
    check();
    return { ...projection, backendSource: target.backendSource, servingVersion: after,
      context: "same_session_corroboration" as const };
  } catch (error) {
    if (error instanceof DesktopCreditDiagnosticError) throw error;
    throw new DesktopCreditDiagnosticError("unavailable");
  }
}

export async function projectDesktopCreditDiagnostic(value: ProviderSettingsSnapshot, now = Date.now(), check = () => {}) {
  const parsed = ProviderSettingsSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new DesktopCreditDiagnosticError("unavailable");
  const snapshot = parsed.data;
  const matrixSources = snapshot.accessSources.filter(source => source.kind === "matrix_gateway");
  const sources = [];
  for (const source of matrixSources) {
    check();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`matrix-credit-diagnostic/source/v1\0${source.id}`));
    check();
    const usage = source.usage;
    const chat = usage.kind === "managed_credit" ? usage.chatAvailability : undefined;
    const displayed = gatewayChatAvailableMicrousd(source, now);
    sources.push({
      sourceSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
      usageKind: usage.kind, usageState: usage.state,
      reason: usage.kind === "unavailable" ? usage.reason : null,
      readinessState: source.readiness.state, safeReason: source.readiness.safeReason,
      asOf: usage.asOf, chatAvailabilityPresent: chat !== undefined,
      chatAvailabilityAsOf: chat?.asOf ?? null,
      rawEligibleBalancePositive: chat ? chat.eligibleBalanceMicrousd > 0 : null,
      rawAvailableBalancePositive: chat ? chat.availableBalanceMicrousd > 0 : null,
      displayedChatCreditAvailable: displayed !== null,
      displayedChatCreditPositive: displayed === null ? null : displayed > 0,
    });
  }
  return {
    contractVersion: 1 as const, observedAt: new Date(now).toISOString(),
    acceptedSnapshotRevision: snapshot.revision, refreshedAt: snapshot.refreshedAt,
    selectedSource: "unknown" as const,
    policyPresent: snapshot.gatewayPolicy !== null,
    inventoryPresent: snapshot.matrixModelInventory !== undefined,
    rawEnabledInventoryModelCount: snapshot.matrixModelInventory?.filter(model => model.enabled).length ?? null,
    rawEnabledCatalogModelCount: snapshot.modelProviders.reduce((count, provider) => count + provider.models.filter(model => model.enabled).length, 0),
    sources,
  };
}
export type DesktopCreditDiagnosticObservation = Awaited<ReturnType<typeof readDesktopCreditDiagnostic>>;

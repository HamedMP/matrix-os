import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentSettingsUpdateSchema,
  ProviderSettingsMutationSchema,
  type AiProviderSnapshotV3,
  type ProviderHarnessKind,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { AgentRuntimeController } from "../agent-config/runtime-controller.js";
import { readAgentConfig, readConfig } from "../agent-config/runtime-files.js";
import { readRuntimeSnapshot, type AgentRuntimeSource } from "../agent-config/service.js";
import type { ProviderSettingsRuntimeCoordinator } from "./provider-settings-coordinators.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";
import {
  MAX_PROVIDER_SETTINGS_RECEIPTS,
  ProviderSettingsConfigurationSchema,
  writeProviderJsonAtomic,
  type HarnessConfiguration,
  type ProviderSettingsConfiguration,
} from "./provider-settings-persistence.js";

const MAX_RECEIPT_FILE_BYTES = 256 * 1024;
const MAX_OWNER_SETTINGS_FILE_BYTES = 1024 * 1024;
const RECEIPT_PATH = "system/ai-providers/runtime-receipts.json";
const REPAIR_PATH = "system/ai-providers/runtime-repair.json";
const OWNER_SETTINGS_PATH = "system/ai-providers/settings.json";
const GenericHarnessSchema = z.enum(["hermes", "openclaw", "pi", "opencode"]);
const CodingHarnessSchema = z.enum(["pi", "opencode"]);
const SystemHarnessSchema = z.enum(["hermes", "openclaw"]);
const RuntimeRouteSchema = z.object({
  harness: SystemHarnessSchema,
  providerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  modelId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/),
}).strict();
const ReceiptSchema = z.object({
  key: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  payloadHash: z.string().length(64).regex(/^[a-f0-9]+$/),
  state: z.enum(["prepared", "applied", "compensation_pending"]).default("applied"),
  beforeRoute: RuntimeRouteSchema.optional(),
  afterRoute: RuntimeRouteSchema.optional(),
  beforeRevision: z.number().int().min(0).optional(),
  afterRevision: z.number().int().min(0).optional(),
}).strict().superRefine((receipt, context) => {
  if ((receipt.beforeRoute === undefined) !== (receipt.afterRoute === undefined)) {
    context.addIssue({ code: "custom", message: "Incomplete provider runtime receipt route" });
  }
  if (receipt.state !== "applied" && !receipt.beforeRoute) {
    context.addIssue({ code: "custom", message: "Recoverable provider runtime receipt is missing routes" });
  }
  if (receipt.afterRevision !== undefined && receipt.beforeRevision === undefined) {
    context.addIssue({ code: "custom", message: "Incomplete provider runtime receipt revision" });
  }
});
const ReceiptDocumentSchema = z.object({
  version: z.literal(1),
  receipts: z.array(ReceiptSchema).max(MAX_PROVIDER_SETTINGS_RECEIPTS),
}).strict();
const RepairDocumentSchema = z.object({
  version: z.literal(1),
  repair: ReceiptSchema.nullable(),
}).strict();
type GenericHarness = z.infer<typeof GenericHarnessSchema>;
type RuntimeRoute = z.infer<typeof RuntimeRouteSchema>;
type RuntimeReceipt = z.infer<typeof ReceiptSchema>;
type RuntimeState = { route: RuntimeRoute; revision: number };

export async function reconcileProviderRuntimeAtStartup(
  coordinator: Pick<ProviderSettingsRuntimeCoordinator, "reconcilePending">,
): Promise<void> {
  try {
    await coordinator.reconcilePending();
  } catch (error) {
    console.warn(
      "[provider-settings] Generic harness startup recovery deferred:",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readReceipts(path: string): Promise<z.infer<typeof ReceiptDocumentSchema>> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECEIPT_FILE_BYTES) {
      throw new Error("Unsafe provider runtime receipt file");
    }
    return ReceiptDocumentSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissing(error)) return { version: 1, receipts: [] };
    throw error;
  }
}

async function readRepair(path: string): Promise<z.infer<typeof RepairDocumentSchema>> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECEIPT_FILE_BYTES) {
      throw new Error("Unsafe provider runtime repair file");
    }
    return RepairDocumentSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissing(error)) return { version: 1, repair: null };
    throw error;
  }
}

async function readOwnerReceiptCommitments(path: string): Promise<Array<{
  key: string;
  payloadHash: string;
}>> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size > MAX_OWNER_SETTINGS_FILE_BYTES) {
      throw new Error("Unsafe owner provider settings file");
    }
    return ProviderSettingsConfigurationSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    ).receipts.map(({ key, payloadHash }) => ({ key, payloadHash }));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function mutationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function affectedHarness(input: {
  mutation: Parameters<ProviderSettingsRuntimeCoordinator["applyConfiguration"]>[0]["mutation"];
  before: ProviderSettingsConfiguration;
  after: ProviderSettingsConfiguration;
}): { before?: HarnessConfiguration; after?: HarnessConfiguration } {
  if (input.mutation.type === "add_harness") {
    const previousIds = new Set(input.before.harnesses.map((harness) => harness.id));
    return { after: input.after.harnesses.find((harness) => !previousIds.has(harness.id)) };
  }
  if (!("harnessInstanceId" in input.mutation)) return {};
  const id = input.mutation.harnessInstanceId;
  return {
    before: input.before.harnesses.find((harness) => harness.id === id),
    after: input.after.harnesses.find((harness) => harness.id === id),
  };
}

function requireGenericHarness(
  harness: HarnessConfiguration | undefined,
): HarnessConfiguration & { harness: GenericHarness } {
  if (!harness || !GenericHarnessSchema.safeParse(harness.harness).success) {
    throw new ProviderSettingsStoreError("runtime_unavailable", 503);
  }
  if (harness.route.kind !== "configurable") {
    throw new ProviderSettingsStoreError("invalid_route", 400);
  }
  return harness as HarnessConfiguration & { harness: GenericHarness };
}

function canonicalDriverInstalled(
  harness: GenericHarness,
  canonical: AiProviderSnapshotV3,
): boolean {
  const driver = canonical.drivers.find((candidate) => candidate.id === harness);
  return driver?.installState === "installed"
    && driver.health !== "unavailable"
    && (systemHarness(harness) || driver.health !== "stopped");
}

function systemHarness(harness: ProviderHarnessKind): harness is "hermes" | "openclaw" {
  return harness === "hermes" || harness === "openclaw";
}

export function createProviderGenericHarnessCoordinator(options: {
  homePath: string;
  runtimeController: Pick<AgentRuntimeController, "update">;
  runtimeSource: AgentRuntimeSource;
  enabledCodingHarnesses: readonly ("pi" | "opencode")[];
  receiptWriter?: typeof writeProviderJsonAtomic;
}): ProviderSettingsRuntimeCoordinator {
  if (!options.homePath) throw new Error("Provider generic harness home path is required");
  if (!options.runtimeController) throw new Error("Provider generic harness runtime controller is required");
  if (typeof options.runtimeSource !== "function") throw new Error("Provider generic harness runtime source is required");
  const enabledCodingHarnesses = new Set(
    CodingHarnessSchema.array().max(2).parse([...options.enabledCodingHarnesses]),
  );
  const receiptPath = join(options.homePath, RECEIPT_PATH);
  const repairPath = join(options.homePath, REPAIR_PATH);
  const ownerSettingsPath = join(options.homePath, OWNER_SETTINGS_PATH);
  const writeReceiptDocument = options.receiptWriter ?? writeProviderJsonAtomic;
  let tail: Promise<void> = Promise.resolve();
  let recoveryBlocked = false;
  let pendingReceiptRepair: RuntimeReceipt | undefined;

  async function requireRuntimeSupport(
    harness: HarnessConfiguration & { harness: GenericHarness },
    canonical: AiProviderSnapshotV3,
  ): Promise<void> {
    if (!canonicalDriverInstalled(harness.harness, canonical)) {
      throw new ProviderSettingsStoreError("runtime_unavailable", 503);
    }
    if (!systemHarness(harness.harness)) {
      if (!enabledCodingHarnesses.has(harness.harness)) {
        throw new ProviderSettingsStoreError("runtime_unavailable", 503);
      }
      return;
    }
    const snapshot = await readRuntimeSnapshot(options.runtimeSource);
    const runtime = snapshot.runtime.options.find((candidate) => candidate.id === harness.harness);
    const healthy = runtime?.health === "healthy" || runtime?.health === "degraded";
    const inactiveActivationTarget = runtime?.health === "stopped"
      && runtime.selectionState === "available";
    if (runtime?.installState !== "installed"
      || (!healthy && !inactiveActivationTarget)) {
      throw new ProviderSettingsStoreError("runtime_unavailable", 503);
    }
  }

  async function applySystemRoute(harness: HarnessConfiguration & {
    harness: "hermes" | "openclaw";
  }): Promise<number> {
    const config = await readConfig(join(options.homePath, "system/config.json"));
    const revision = readAgentConfig(config).value.revision ?? 0;
    const update = AgentSettingsUpdateSchema.safeParse({
      revision,
      runtime: harness.harness,
      provider: harness.route.providerId,
      messagingModel: harness.route.modelId,
    });
    if (!update.success) throw new ProviderSettingsStoreError("invalid_route", 400);
    return (await options.runtimeController.update(update.data)).revision;
  }

  async function currentRuntimeState(): Promise<RuntimeState> {
    const config = await readConfig(join(options.homePath, "system/config.json"));
    const revision = readAgentConfig(config).value.revision ?? 0;
    const snapshot = await readRuntimeSnapshot(options.runtimeSource);
    return {
      route: RuntimeRouteSchema.parse({
        harness: snapshot.runtime.selected,
        providerId: snapshot.messaging.provider,
        modelId: snapshot.messaging.model,
      }),
      revision,
    };
  }

  function configuredRuntimeRoute(harness: HarnessConfiguration & {
    harness: "hermes" | "openclaw";
  }): RuntimeRoute {
    return RuntimeRouteSchema.parse({
      harness: harness.harness,
      providerId: harness.route.providerId,
      modelId: harness.route.modelId,
    });
  }

  async function applyRuntimeRoute(route: RuntimeRoute): Promise<number> {
    return await applySystemRoute({
      id: `recovery_${route.harness}`,
      driverId: route.harness,
      harness: route.harness,
      displayName: route.harness,
      accentColor: null,
      enabled: true,
      selectedAccountId: null,
      accessSourceId: null,
      route: { kind: "configurable", providerId: route.providerId, modelId: route.modelId },
    });
  }

  function sameRuntimeRoute(left: RuntimeRoute, right: RuntimeRoute): boolean {
    return left.harness === right.harness && left.providerId === right.providerId
      && left.modelId === right.modelId;
  }

  async function writeReceipts(receipts: z.infer<typeof ReceiptDocumentSchema>): Promise<void> {
    await writeReceiptDocument(receiptPath, ReceiptDocumentSchema.parse(receipts));
  }

  async function writeRepair(repair: RuntimeReceipt | null): Promise<void> {
    await writeReceiptDocument(repairPath, RepairDocumentSchema.parse({ version: 1, repair }));
  }

  function replaceReceipt(
    receipts: z.infer<typeof ReceiptDocumentSchema>,
    receipt: RuntimeReceipt,
  ): void {
    receipts.receipts = receipts.receipts.filter((candidate) => candidate.key !== receipt.key);
    receipts.receipts.push(ReceiptSchema.parse(receipt));
    if (receipts.receipts.length > MAX_PROVIDER_SETTINGS_RECEIPTS) {
      receipts.receipts.splice(0, receipts.receipts.length - MAX_PROVIDER_SETTINGS_RECEIPTS);
    }
  }

  async function compensatePendingReceipt(
    receipts: z.infer<typeof ReceiptDocumentSchema>,
    receipt: RuntimeReceipt,
  ): Promise<void> {
    const beforeRoute = receipt.beforeRoute;
    const afterRoute = receipt.afterRoute;
    if (!beforeRoute || !afterRoute) {
      throw new ProviderSettingsStoreError("runtime_unavailable", 503);
    }
    const current = await currentRuntimeState();
    const displacedGeneration = receipt.afterRevision !== undefined
      && current.revision !== receipt.afterRevision;
    if (sameRuntimeRoute(current.route, beforeRoute)) {
      // The compensation target is already active.
    } else if (sameRuntimeRoute(current.route, afterRoute) && !displacedGeneration) {
      try {
        await applyRuntimeRoute(beforeRoute);
      } catch (error) {
        console.warn(
          "[provider-settings] Pending generic harness compensation failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
        throw new ProviderSettingsStoreError("runtime_unavailable", 503);
      }
    } else {
      if (receipt.state !== "applied" && !displacedGeneration) {
        throw new ProviderSettingsStoreError("runtime_unavailable", 503);
      }
      // An applied receipt on a different route, or any receipt whose live
      // generation no longer matches its applied generation, has been
      // displaced by a newer runtime writer. Persist that exact live state
      // before clearing the stale receipt so a crash cannot later revive its
      // historical rollback target.
      replaceReceipt(receipts, ReceiptSchema.parse({
        ...receipt,
        beforeRoute: current.route,
        beforeRevision: current.revision,
      }));
      await writeReceipts(receipts);
    }
    receipts.receipts = receipts.receipts.filter((candidate) => candidate.key !== receipt.key);
    await writeReceipts(receipts);
  }

  async function reconcilePendingReceipts(
    receipts: z.infer<typeof ReceiptDocumentSchema>,
    excludedKey?: string,
  ): Promise<void> {
    const ownerCommitments = await readOwnerReceiptCommitments(ownerSettingsPath);
    const retained = receipts.receipts.filter((receipt) => {
      if (receipt.key === excludedKey || receipt.state !== "applied") return true;
      const ownerCommitted = ownerCommitments.some((commitment) =>
        commitment.key === receipt.key && commitment.payloadHash === receipt.payloadHash,
      );
      return receipt.beforeRoute !== undefined && !ownerCommitted;
    });
    if (retained.length !== receipts.receipts.length) {
      receipts.receipts = retained;
      await writeReceipts(receipts);
    }
    const pending = receipts.receipts
      .filter((receipt) => receipt.key !== excludedKey
        && (receipt.state !== "applied" || receipt.beforeRoute !== undefined))
      .reverse();
    for (const receipt of pending) {
      await compensatePendingReceipt(receipts, receipt);
    }
  }

  async function recoverPendingReceipts(): Promise<void> {
    try {
      const receipts = await readReceipts(receiptPath);
      const durableRepair = await readRepair(repairPath);
      const repair = pendingReceiptRepair ?? durableRepair.repair ?? undefined;
      if (repair) {
        const durable = receipts.receipts.find((receipt) => receipt.key === repair.key);
        if (durable && durable.payloadHash !== repair.payloadHash) {
          throw new ProviderSettingsStoreError("runtime_unavailable", 503);
        }
        if (durable) {
          replaceReceipt(receipts, repair);
          await writeReceipts(receipts);
        }
        await writeRepair(null);
        pendingReceiptRepair = undefined;
      }
      await reconcilePendingReceipts(receipts);
      recoveryBlocked = false;
    } catch (error) {
      recoveryBlocked = true;
      console.warn(
        "[provider-settings] Generic harness recovery remains pending:",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new ProviderSettingsStoreError("runtime_unavailable", 503);
    }
  }

  async function requireRecoveryReady(): Promise<void> {
    if (recoveryBlocked) await recoverPendingReceipts();
  }

  async function runtimeTarget(
    input: Parameters<ProviderSettingsRuntimeCoordinator["applyConfiguration"]>[0],
    mutation: z.infer<typeof ProviderSettingsMutationSchema>,
    target: HarnessConfiguration & { harness: GenericHarness },
  ): Promise<RuntimeRoute | null> {
    if (!systemHarness(target.harness)) return null;
    const systemTarget = target as typeof target & { harness: "hermes" | "openclaw" };
    const affected = affectedHarness(input);
    if (mutation.type === "set_harness_enabled" && mutation.enabled === false) {
      const runtime = await readRuntimeSnapshot(options.runtimeSource);
      if (runtime.runtime.selected !== target.harness) return null;
      const fallback = input.after.harnesses.find((harness) =>
        harness.enabled && systemHarness(harness.harness) && harness.id !== target.id,
      );
      const supportedFallback = requireGenericHarness(fallback);
      await requireRuntimeSupport(supportedFallback, input.canonical);
      return configuredRuntimeRoute(supportedFallback as typeof supportedFallback & {
        harness: "hermes" | "openclaw";
      });
    }
    if (affected.after?.enabled === true
      && mutation.type !== "update_harness"
      && mutation.type !== "remove_harness") {
      return configuredRuntimeRoute(systemTarget);
    }
    return null;
  }

  async function coordinate(
    input: Parameters<ProviderSettingsRuntimeCoordinator["applyConfiguration"]>[0],
  ): Promise<void> {
    if (pendingReceiptRepair) await recoverPendingReceipts();
    const mutation = ProviderSettingsMutationSchema.parse(input.mutation);
    const payloadHash = mutationHash(mutation);
    const receipts = await readReceipts(receiptPath);
    const duplicate = receipts.receipts.find((receipt) => receipt.key === input.idempotencyKey);
    if (duplicate) {
      if (duplicate.payloadHash !== payloadHash) {
        throw new ProviderSettingsStoreError("idempotency_conflict", 409);
      }
    }
    try {
      await reconcilePendingReceipts(receipts, duplicate?.key);
    } catch (error) {
      recoveryBlocked = true;
      if (error instanceof ProviderSettingsStoreError) throw error;
      throw new ProviderSettingsStoreError("runtime_unavailable", 503);
    }
    if (duplicate) {
      const beforeRoute = duplicate.beforeRoute;
      const afterRoute = duplicate.afterRoute;
      if (duplicate.state === "applied") {
        if (!beforeRoute || !afterRoute) return;
        const current = await currentRuntimeState();
        if (!sameRuntimeRoute(current.route, afterRoute)) {
          const repaired = ReceiptSchema.parse({
            ...duplicate,
            state: "prepared",
            beforeRoute: current.route,
            beforeRevision: current.revision,
            afterRevision: undefined,
          });
          replaceReceipt(receipts, repaired);
          recoveryBlocked = true;
          pendingReceiptRepair = repaired;
          await writeRepair(repaired);
          await writeReceipts(receipts);
          await writeRepair(null);
          pendingReceiptRepair = undefined;
          repaired.afterRevision = await applyRuntimeRoute(afterRoute);
          repaired.state = "applied";
          replaceReceipt(receipts, repaired);
          await writeReceipts(receipts);
        }
        return;
      }
      if (!beforeRoute || !afterRoute) throw new ProviderSettingsStoreError("runtime_unavailable", 503);
      const current = await currentRuntimeState();
      if (sameRuntimeRoute(current.route, afterRoute)) {
        duplicate.state = "applied";
        duplicate.afterRevision = duplicate.beforeRevision === undefined
          ? undefined
          : current.revision;
        await writeReceipts(receipts);
        return;
      }
      if (!sameRuntimeRoute(current.route, beforeRoute)) {
        throw new ProviderSettingsStoreError("runtime_unavailable", 503);
      }
      receipts.receipts = receipts.receipts.filter((receipt) => receipt.key !== duplicate.key);
      await writeReceipts(receipts);
    }

    const affected = affectedHarness(input);
    const target = requireGenericHarness(affected.after ?? affected.before);

    if (mutation.type === "remove_harness" && affected.before?.enabled === true) {
      throw new ProviderSettingsStoreError("invalid_request", 400);
    }

    const localOnly = mutation.type === "remove_harness"
      || mutation.type === "update_harness"
      || (mutation.type === "set_harness_enabled" && mutation.enabled === false);
    if (!localOnly) await requireRuntimeSupport(target, input.canonical);

    const afterRoute = await runtimeTarget(input, mutation, target);
    if (!afterRoute) {
      replaceReceipt(receipts, { key: input.idempotencyKey, payloadHash, state: "applied" });
      await writeReceipts(receipts);
      return;
    }
    const before = await currentRuntimeState();
    const beforeRoute = before.route;
    const receipt: RuntimeReceipt = {
      key: input.idempotencyKey,
      payloadHash,
      state: "prepared",
      beforeRoute,
      afterRoute,
      beforeRevision: before.revision,
    };
    replaceReceipt(receipts, receipt);
    await writeReceipts(receipts);
    recoveryBlocked = true;
    receipt.afterRevision = sameRuntimeRoute(beforeRoute, afterRoute)
      ? before.revision
      : await applyRuntimeRoute(afterRoute);
    receipt.state = "applied";
    replaceReceipt(receipts, receipt);
    try {
      await writeReceipts(receipts);
    } catch (error) {
      try {
        if (!sameRuntimeRoute(beforeRoute, afterRoute)) await applyRuntimeRoute(beforeRoute);
        receipts.receipts = receipts.receipts.filter((candidate) => candidate.key !== receipt.key);
        await writeReceipts(receipts);
        recoveryBlocked = false;
      } catch (rollbackError) {
        console.warn(
          "[provider-settings] Generic harness receipt rollback failed:",
          rollbackError instanceof Error ? rollbackError.name : "UnknownError",
        );
      }
      throw error;
    }
  }

  async function rollback(
    input: Parameters<ProviderSettingsRuntimeCoordinator["rollbackConfiguration"]>[0],
  ): Promise<void> {
    const payloadHash = mutationHash(ProviderSettingsMutationSchema.parse(input.mutation));
    const receipts = await readReceipts(receiptPath);
    const receipt = receipts.receipts.find((candidate) => candidate.key === input.idempotencyKey);
    if (!receipt) return;
    if (receipt.payloadHash !== payloadHash) {
      throw new ProviderSettingsStoreError("idempotency_conflict", 409);
    }
    if (!receipt.beforeRoute || !receipt.afterRoute) {
      receipts.receipts = receipts.receipts.filter((candidate) => candidate.key !== receipt.key);
      await writeReceipts(receipts);
      return;
    }
    receipt.state = "compensation_pending";
    recoveryBlocked = true;
    let markerDurable = false;
    try {
      await writeReceipts(receipts);
      markerDurable = true;
    } catch (error) {
      console.warn(
        "[provider-settings] Generic harness compensation marker unavailable:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }

    let compensationError: unknown;
    try {
      const current = await currentRuntimeState();
      if (sameRuntimeRoute(current.route, receipt.afterRoute)) {
        await applyRuntimeRoute(receipt.beforeRoute);
      } else if (!sameRuntimeRoute(current.route, receipt.beforeRoute)) {
        throw new ProviderSettingsStoreError("runtime_unavailable", 503);
      }
    } catch (error) {
      compensationError = error;
    }

    if (compensationError !== undefined) {
      if (!markerDurable) {
        try {
          await writeReceipts(receipts);
          markerDurable = true;
        } catch (error) {
          console.warn(
            "[provider-settings] Generic harness compensation recovery marker unavailable:",
            error instanceof Error ? error.name : "UnknownError",
          );
        }
      }
      if (!markerDurable) recoveryBlocked = true;
      throw compensationError;
    }

    receipts.receipts = receipts.receipts.filter((candidate) => candidate.key !== receipt.key);
    try {
      await writeReceipts(receipts);
    } catch (error) {
      replaceReceipt(receipts, receipt);
      try {
        await writeReceipts(receipts);
      } catch (markerError) {
        recoveryBlocked = true;
        console.warn(
          "[provider-settings] Generic harness compensated receipt remains uncertain:",
          markerError instanceof Error ? markerError.name : "UnknownError",
        );
      }
      throw error;
    }
  }

  function serialize(operation: () => Promise<void>): Promise<void> {
    const pending = tail.then(operation);
    tail = pending.catch((error: unknown) => {
      console.warn(
        "[provider-settings] Generic harness configuration failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
    return pending;
  }

  return {
    supportedHarnessKinds: [
      "hermes" as const,
      "openclaw" as const,
      ...CodingHarnessSchema.options.filter((harness) => enabledCodingHarnesses.has(harness)),
    ],
    supportedActions: [
      "add_harness",
      "remove_harness",
      "update_harness",
      "set_harness_enabled",
      "set_route",
    ],
    isRecoveryReady() {
      return !recoveryBlocked;
    },
    reconcilePending() {
      return serialize(recoverPendingReceipts);
    },
    applyConfiguration(input) {
      return serialize(async () => {
        await coordinate(input);
        recoveryBlocked = false;
      });
    },
    rollbackConfiguration(input) {
      return serialize(async () => {
        await requireRecoveryReady();
        await rollback(input);
        recoveryBlocked = false;
      });
    },
  };
}

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
  writeProviderJsonAtomic,
  type HarnessConfiguration,
  type ProviderSettingsConfiguration,
} from "./provider-settings-persistence.js";

const MAX_RECEIPT_FILE_BYTES = 256 * 1024;
const RECEIPT_PATH = "system/ai-providers/runtime-receipts.json";
const GenericHarnessSchema = z.enum(["hermes", "openclaw", "pi", "opencode"]);
const CodingHarnessSchema = z.enum(["pi", "opencode"]);
const ReceiptSchema = z.object({
  key: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  payloadHash: z.string().length(64).regex(/^[a-f0-9]+$/),
}).strict();
const ReceiptDocumentSchema = z.object({
  version: z.literal(1),
  receipts: z.array(ReceiptSchema).max(MAX_PROVIDER_SETTINGS_RECEIPTS),
}).strict();
type GenericHarness = z.infer<typeof GenericHarnessSchema>;

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
}): ProviderSettingsRuntimeCoordinator {
  if (!options.homePath) throw new Error("Provider generic harness home path is required");
  if (!options.runtimeController) throw new Error("Provider generic harness runtime controller is required");
  if (typeof options.runtimeSource !== "function") throw new Error("Provider generic harness runtime source is required");
  const enabledCodingHarnesses = new Set(
    CodingHarnessSchema.array().max(2).parse([...options.enabledCodingHarnesses]),
  );
  const receiptPath = join(options.homePath, RECEIPT_PATH);
  let tail: Promise<void> = Promise.resolve();

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
  }): Promise<void> {
    const config = await readConfig(join(options.homePath, "system/config.json"));
    const revision = readAgentConfig(config).value.revision ?? 0;
    const update = AgentSettingsUpdateSchema.safeParse({
      revision,
      runtime: harness.harness,
      provider: harness.route.providerId,
      messagingModel: harness.route.modelId,
    });
    if (!update.success) throw new ProviderSettingsStoreError("invalid_route", 400);
    await options.runtimeController.update(update.data);
  }

  async function coordinate(
    input: Parameters<ProviderSettingsRuntimeCoordinator["applyConfiguration"]>[0],
  ): Promise<void> {
    const mutation = ProviderSettingsMutationSchema.parse(input.mutation);
    const payloadHash = mutationHash(mutation);
    const receipts = await readReceipts(receiptPath);
    const duplicate = receipts.receipts.find((receipt) => receipt.key === input.idempotencyKey);
    if (duplicate) {
      if (duplicate.payloadHash !== payloadHash) {
        throw new ProviderSettingsStoreError("idempotency_conflict", 409);
      }
      return;
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

    if (systemHarness(target.harness)) {
      const systemTarget = target as typeof target & { harness: "hermes" | "openclaw" };
      if (mutation.type === "set_harness_enabled" && mutation.enabled === false) {
        const runtime = await readRuntimeSnapshot(options.runtimeSource);
        if (runtime.runtime.selected === target.harness) {
          const fallback = input.after.harnesses.find((harness) =>
            harness.enabled && systemHarness(harness.harness) && harness.id !== target.id,
          );
          const supportedFallback = requireGenericHarness(fallback);
          await requireRuntimeSupport(supportedFallback, input.canonical);
          await applySystemRoute(supportedFallback as typeof supportedFallback & {
            harness: "hermes" | "openclaw";
          });
        }
      } else if (affected.after?.enabled === true
        && mutation.type !== "update_harness"
        && mutation.type !== "remove_harness") {
        await applySystemRoute(systemTarget);
      }
    }

    receipts.receipts.push({ key: input.idempotencyKey, payloadHash });
    if (receipts.receipts.length > MAX_PROVIDER_SETTINGS_RECEIPTS) {
      receipts.receipts.splice(0, receipts.receipts.length - MAX_PROVIDER_SETTINGS_RECEIPTS);
    }
    await writeProviderJsonAtomic(receiptPath, ReceiptDocumentSchema.parse(receipts));
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
    applyConfiguration(input) {
      const pending = tail.then(() => coordinate(input));
      tail = pending.catch(() => undefined);
      return pending;
    },
  };
}

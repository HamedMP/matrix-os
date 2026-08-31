import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { join } from "node:path";
import {
  ProviderAccentColorSchema,
  ProviderConnectionAttemptSchema,
  ProviderGatewayPolicySchema,
  ProviderHarnessKindSchema,
  ProviderHarnessRouteSchema,
  ProviderLoginMethodSchema,
  type AiProviderSnapshotV3,
  type ProviderHarnessKind,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { resolveProviderSettingsDriverId } from "./provider-settings-driver-id.js";

const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_PROVIDER_SETTINGS_RECEIPTS = 256;
const SafeRefSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

export const HarnessConfigurationSchema = z.object({
  id: SafeRefSchema,
  driverId: SafeRefSchema,
  harness: ProviderHarnessKindSchema,
  displayName: z.string().min(1).max(120),
  accentColor: ProviderAccentColorSchema.nullable(),
  enabled: z.boolean(),
  selectedAccountId: SafeRefSchema.nullable(),
  accessSourceId: SafeRefSchema.nullable(),
  route: ProviderHarnessRouteSchema,
}).strict();

export const AccountConfigurationSchema = z.object({
  id: SafeRefSchema,
  providerId: SafeRefSchema,
  displayName: z.string().min(1).max(120),
  authMethod: ProviderLoginMethodSchema,
  accessSourceId: SafeRefSchema,
}).strict();

const ReceiptSchema = z.object({
  key: SafeRefSchema,
  payloadHash: z.string().length(64).regex(/^[a-f0-9]+$/),
  appliedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  attempt: ProviderConnectionAttemptSchema.optional(),
}).strict();

export const ProviderSettingsConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  harnesses: z.array(HarnessConfigurationSchema).max(128),
  accountProfiles: z.array(AccountConfigurationSchema).max(128),
  gatewayPolicy: ProviderGatewayPolicySchema.nullable(),
  receipts: z.array(ReceiptSchema).max(MAX_PROVIDER_SETTINGS_RECEIPTS),
}).strict().superRefine((config, context) => {
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(config.harnesses.map((harness) => harness.id))) {
    context.addIssue({ code: "custom", path: ["harnesses"], message: "Duplicate harness id" });
  }
  if (!unique(config.accountProfiles.map((account) => account.id))) {
    context.addIssue({ code: "custom", path: ["accountProfiles"], message: "Duplicate account id" });
  }
  if (!unique(config.receipts.map((receipt) => receipt.key))) {
    context.addIssue({ code: "custom", path: ["receipts"], message: "Duplicate idempotency key" });
  }
  if (config.receipts.some((receipt) => receipt.appliedRevision > config.revision)) {
    context.addIssue({ code: "custom", path: ["receipts"], message: "Receipt exceeds settings revision" });
  }
});

const ProviderSecretDocumentSchema = z.object({
  version: z.literal(1),
  accounts: z.record(SafeRefSchema, z.string().min(1).max(64 * 1024)),
}).strict();

export type HarnessConfiguration = z.infer<typeof HarnessConfigurationSchema>;
export type AccountConfiguration = z.infer<typeof AccountConfigurationSchema>;
export type ProviderSettingsConfiguration = z.infer<typeof ProviderSettingsConfigurationSchema>;
export type ProviderSecretDocument = z.infer<typeof ProviderSecretDocumentSchema>;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readBoundedJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_FILE_BYTES) {
    throw new Error("Unsafe provider settings file");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeProviderJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Unsafe provider settings directory");
  await chmod(directory, 0o700);
  const temporaryPath = join(directory, `.${basename(path)}.tmp`);
  let temporaryCreated = false;
  try {
    try {
      const temporaryMetadata = await lstat(temporaryPath);
      if (!temporaryMetadata.isFile() || temporaryMetadata.isSymbolicLink()) {
        throw new Error("Unsafe provider settings temporary file");
      }
      await unlink(temporaryPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    temporaryCreated = true;
    await rename(temporaryPath, path);
    temporaryCreated = false;
    await chmod(path, 0o600);
  } catch (error) {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch((cleanupError: unknown) => {
        if (!isMissing(cleanupError)) console.warn("[provider-settings] Failed to clean temporary settings file");
      });
    }
    throw error;
  }
}

function driverIdForHarness(kind: ProviderHarnessKind, canonical: AiProviderSnapshotV3): string {
  return resolveProviderSettingsDriverId({
    driverId: kind === "claude" ? "kernel" : kind,
    harness: kind,
    canonical,
  });
}

function harnessKindForDriver(driverId: string): ProviderHarnessKind {
  if (driverId === "kernel" || driverId === "claude_code") return "claude";
  return ProviderHarnessKindSchema.catch("opencode").parse(driverId);
}

export function initialProviderSettingsConfiguration(canonical: AiProviderSnapshotV3): ProviderSettingsConfiguration {
  const harnesses = canonical.drivers.flatMap((driver): HarnessConfiguration[] => {
    const candidates = canonical.instances.filter((instance) => instance.driverId === driver.id);
    const instance = candidates.find((candidate) => candidate.id === canonical.active.providerInstanceId)
      ?? candidates.find((candidate) => candidate.readiness.state === "ready")
      ?? candidates[0];
    const modelId = instance?.defaultModelId ?? instance?.modelIds[0];
    if (!instance || !modelId) return [];
    const harness = harnessKindForDriver(driver.id);
    return [{
      id: `harness_${driver.id}`,
      driverId: driver.id,
      harness,
      displayName: driver.displayName,
      accentColor: null,
      enabled: driver.installState === "installed",
      selectedAccountId: instance.accountId,
      accessSourceId: instance.accessSourceId,
      route: { kind: harness === "claude" ? "fixed" : "configurable", providerId: instance.vendor, modelId },
    }];
  });
  const gateway = canonical.accessSources.find((source) =>
    source.fundingKind === "matrix_included" || source.fundingKind === "matrix_addon");
  return {
    schemaVersion: 1,
    revision: 0,
    harnesses,
    accountProfiles: canonical.accounts.flatMap((account) => {
      if (account.authMethod === null) return [];
      const instance = canonical.instances.find((candidate) => {
        if (candidate.accountId !== account.id) return false;
        const source = canonical.accessSources.find((value) => value.id === candidate.accessSourceId);
        return account.authMethod === "api_key"
          ? source?.fundingKind === "owner_api_key"
          : source?.fundingKind === "owner_account";
      });
      if (!instance) return [];
      return [{
        id: account.id,
        providerId: account.vendor,
        displayName: account.accountLabel ?? `${account.vendor} account`,
        authMethod: account.authMethod === "provider_profile" ? "terminal" as const
          : account.authMethod === "oauth_pkce" ? "oauth" as const : "api_key" as const,
        accessSourceId: instance.accessSourceId,
      }];
    }),
    gatewayPolicy: gateway ? {
      accessSourceId: gateway.id,
      monthlyBudgetMicrousd: null,
      allowedModelIds: [...gateway.eligibleModelIds],
      topUpEnabled: false,
    } : null,
    receipts: [],
  };
}

export function providerDriverId(kind: ProviderHarnessKind, canonical: AiProviderSnapshotV3): string {
  return driverIdForHarness(kind, canonical);
}

export async function readProviderSettingsConfiguration(
  path: string,
  canonical: AiProviderSnapshotV3,
): Promise<ProviderSettingsConfiguration> {
  try {
    const value = ProviderSettingsConfigurationSchema.parse(await readBoundedJson(path));
    await chmod(path, 0o600);
    return value;
  } catch (error) {
    if (isMissing(error)) {
      const initial = initialProviderSettingsConfiguration(canonical);
      await writeProviderJsonAtomic(path, initial);
      return initial;
    }
    throw error;
  }
}

export async function readProviderSecrets(path: string): Promise<ProviderSecretDocument> {
  try {
    const value = ProviderSecretDocumentSchema.parse(await readBoundedJson(path));
    await chmod(path, 0o600);
    return value;
  } catch (error) {
    if (isMissing(error)) return { version: 1, accounts: {} };
    throw error;
  }
}

import type { CanonicalProviderDriverKind } from "@matrix-os/contracts";
import type { ScopeRuntimeHostConfig } from "@matrix-os/scope-runtime/host-config";
import {
  runtimeProfileIdentity,
  SCOPE_RUNTIME_BOT_ADAPTER_ID,
  SCOPE_RUNTIME_BOT_HARNESS_VERSION,
  SCOPE_RUNTIME_BOT_PROFILE_ID,
  SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID,
  SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION,
} from "@matrix-os/scope-runtime/bot-profile";
import {
  SCOPE_RUNTIME_CODEX_VERSION,
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "@matrix-os/scope-runtime/profile";
import { SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST, SCOPE_RUNTIME_SANDBOX_POLICY_VERSION } from "@matrix-os/scope-runtime/sandbox";
import { z } from "zod/v4";
import { MATRIX_BOT_INSTANCE_ID } from "../bots/selection.js";
import type { ScopeRuntimeProfileCatalog, ScopeRuntimeProfileCatalogEntry } from "./scope-runtime-client.js";

const ClaudeAdapter = z.strictObject({
  adapterId: z.literal("claude-code"),
  harnessVersion: z.literal(SCOPE_RUNTIME_HARNESS_VERSION),
});
const CodexAdapter = z.strictObject({
  adapterId: z.literal("codex"),
  harnessVersion: z.literal(SCOPE_RUNTIME_CODEX_VERSION),
});
const Adapter = z.discriminatedUnion("adapterId", [ClaudeAdapter, CodexAdapter]);
export type CollaborationAiAdapterId = z.output<typeof Adapter>["adapterId"];

function createEligibilitySchema(chatDigest: string, managedPiDigest: string) {
  const profile = {
    profileId: z.literal(SCOPE_RUNTIME_PROFILE_ID),
    profileVersion: z.literal(SCOPE_RUNTIME_PROFILE_VERSION),
    profileDigest: z.literal(chatDigest),
  };
  const matrixBot = z.strictObject({
    profileId: z.literal(SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID),
    profileVersion: z.literal(SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION),
    profileDigest: z.literal(managedPiDigest),
    adapterId: z.literal(SCOPE_RUNTIME_BOT_ADAPTER_ID),
    harnessVersion: z.literal(SCOPE_RUNTIME_BOT_HARNESS_VERSION),
    workload: z.literal("bot_agent"),
  });
  return z.union([
    z.strictObject({
      ...profile,
      adapters: z.array(Adapter).min(1).max(16).refine(
        (items) => new Set(items.map((item) => item.adapterId)).size === items.length,
        { message: "Duplicate isolated adapter" },
      ),
      matrixBot: matrixBot.optional(),
    }),
    z.strictObject({ ...profile, ...ClaudeAdapter.shape }),
  ]).transform((value) => "adapters" in value ? value : {
    profileId: value.profileId,
    profileVersion: value.profileVersion,
    profileDigest: value.profileDigest,
    adapters: [{ adapterId: value.adapterId, harnessVersion: value.harnessVersion }],
    matrixBot: undefined,
  });
}

export type CollaborationAiExecutionEligibility = z.output<ReturnType<typeof createEligibilitySchema>>;
export const CODEX_SHARED_INSTANCE_ID = "codex_default";

/** Claude serves any bound Claude Instance. Isolated Codex serves its one pinned Instance. */
export function sharedAiAdapterFor(
  driverKind: CanonicalProviderDriverKind,
  instanceId: string,
): CollaborationAiAdapterId | undefined {
  if (driverKind === "claude_code") return "claude-code";
  if (driverKind === "codex" && instanceId === CODEX_SHARED_INSTANCE_ID) return "codex";
  return undefined;
}

/** Only called on literals constructed here (catalog entries, adapters and eligibility templates). */
function freezePolicyData<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) freezePolicyData(child);
  }
  return Object.freeze(value);
}

function catalogEntry(
  { profileVersion, profileDigest }: ReturnType<typeof runtimeProfileIdentity>,
  supportedAdapters: ScopeRuntimeProfileCatalogEntry["supportedAdapters"],
): ScopeRuntimeProfileCatalogEntry {
  return {
    profileVersion, profileDigest,
    identity: { mode: "dynamic", uidMin: 61_184, uidMax: 65_519 },
    sandbox: { policyVersion: SCOPE_RUNTIME_SANDBOX_POLICY_VERSION, policyDigest: SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST },
    supportedAdapters,
  };
}

/** Construct once with canonical, server-owned host configuration. No capability or stored record selects trust. */
export function createGatewayScopeRuntimeProfilePolicy(config?: ScopeRuntimeHostConfig) {
  const owned = config?.ownedNode;
  const chat = runtimeProfileIdentity(SCOPE_RUNTIME_PROFILE_ID, owned);
  const recipe = runtimeProfileIdentity(SCOPE_RUNTIME_BOT_PROFILE_ID, owned);
  const managed = runtimeProfileIdentity(SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID, owned);
  const piAdapters = {
    [SCOPE_RUNTIME_BOT_ADAPTER_ID]: { harnessVersions: [SCOPE_RUNTIME_BOT_HARNESS_VERSION], workloads: ["bot_agent"] },
  } as const;
  const catalog: ScopeRuntimeProfileCatalog = freezePolicyData({
    [SCOPE_RUNTIME_PROFILE_ID]: catalogEntry(chat, {
      "claude-code": { harnessVersions: [SCOPE_RUNTIME_HARNESS_VERSION], workloads: ["chat_ai"] },
      codex: { harnessVersions: [SCOPE_RUNTIME_CODEX_VERSION], workloads: ["chat_ai"] },
    }),
    [SCOPE_RUNTIME_BOT_PROFILE_ID]: catalogEntry(recipe, piAdapters),
    [SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID]: catalogEntry(managed, piAdapters),
  });
  const sharedEligibility = freezePolicyData({
    profileId: SCOPE_RUNTIME_PROFILE_ID,
    profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
    profileDigest: chat.profileDigest,
    adapters: [
      { adapterId: "claude-code", harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION },
      { adapterId: "codex", harnessVersion: SCOPE_RUNTIME_CODEX_VERSION },
    ],
  } satisfies CollaborationAiExecutionEligibility);
  const matrixBotEligibility = freezePolicyData({
    profileId: SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID,
    profileVersion: SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION,
    profileDigest: managed.profileDigest,
    adapterId: SCOPE_RUNTIME_BOT_ADAPTER_ID,
    harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION,
    workload: "bot_agent",
  } as const);
  const schema = createEligibilitySchema(chat.profileDigest, managed.profileDigest);
  return Object.freeze({
    catalog, sharedEligibility, matrixBotEligibility,
    parseEligibility: (value: unknown): CollaborationAiExecutionEligibility => schema.parse(value),
    supportsDriver(value: unknown, driverKind: CanonicalProviderDriverKind, instanceId: string): boolean {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return false;
      if (driverKind === "matrix_bot") return instanceId === MATRIX_BOT_INSTANCE_ID && parsed.data.matrixBot !== undefined;
      const adapterId = sharedAiAdapterFor(driverKind, instanceId);
      return parsed.data.adapters.some((adapter) => adapter.adapterId === adapterId);
    },
    eligibilityEquals(left: unknown, right: unknown): boolean {
      const a = schema.safeParse(left);
      const b = schema.safeParse(right);
      // Both records must qualify, including both optional managed Pi attestations.
      // Parsing normalizes field order and the historical single-Claude shape.
      return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data);
    },
  });
}

export type GatewayScopeRuntimeProfilePolicy = ReturnType<typeof createGatewayScopeRuntimeProfilePolicy>;
export const LEGACY_SCOPE_RUNTIME_PROFILE_POLICY = createGatewayScopeRuntimeProfilePolicy();
export const CollaborationAiExecutionEligibilitySchema = createEligibilitySchema(
  LEGACY_SCOPE_RUNTIME_PROFILE_POLICY.sharedEligibility.profileDigest,
  LEGACY_SCOPE_RUNTIME_PROFILE_POLICY.matrixBotEligibility.profileDigest,
);

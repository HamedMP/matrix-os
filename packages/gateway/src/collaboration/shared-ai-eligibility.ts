import type { CanonicalProviderDriverKind } from "@matrix-os/contracts";
import {
  SCOPE_RUNTIME_CODEX_VERSION,
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "@matrix-os/scope-runtime/profile";
import { z } from "zod/v4";
import { SCOPE_RUNTIME_BOT_PROFILE_ID, SCOPE_RUNTIME_BOT_PROFILE_VERSION, SCOPE_RUNTIME_BOT_PROFILE_DIGEST, SCOPE_RUNTIME_BOT_ADAPTER_ID, SCOPE_RUNTIME_BOT_HARNESS_VERSION } from "@matrix-os/scope-runtime/bot-profile";
import { MATRIX_BOT_INSTANCE_ID } from "../bots/selection.js";

/** Pi is qualified under its own profile/workload, never added to the standard adapter array. */
export const SHARED_MATRIX_BOT_ELIGIBILITY = {
  profileId: SCOPE_RUNTIME_BOT_PROFILE_ID,
  profileVersion: SCOPE_RUNTIME_BOT_PROFILE_VERSION,
  profileDigest: SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
  adapterId: SCOPE_RUNTIME_BOT_ADAPTER_ID,
  harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION,
  workload: "bot_agent",
} as const;
const MatrixBotProfileSchema = z.object({
  profileId: z.literal(SCOPE_RUNTIME_BOT_PROFILE_ID), profileVersion: z.literal(SCOPE_RUNTIME_BOT_PROFILE_VERSION),
  profileDigest: z.literal(SCOPE_RUNTIME_BOT_PROFILE_DIGEST), adapterId: z.literal(SCOPE_RUNTIME_BOT_ADAPTER_ID),
  harnessVersion: z.literal(SCOPE_RUNTIME_BOT_HARNESS_VERSION), workload: z.literal("bot_agent"),
}).strict();

export type CollaborationAiAdapterId = "claude-code" | "codex";

/** The single Instance the isolated Codex adapter, broker, and registry accept. */
export const CODEX_SHARED_INSTANCE_ID = "codex_default";

const ProfileSchema = z.object({
  profileId: z.literal(SCOPE_RUNTIME_PROFILE_ID),
  profileVersion: z.literal(SCOPE_RUNTIME_PROFILE_VERSION),
  profileDigest: z.literal(SCOPE_RUNTIME_PROFILE_DIGEST),
});
const ClaudeAdapterSchema = z.object({
  adapterId: z.literal("claude-code"),
  harnessVersion: z.literal(SCOPE_RUNTIME_HARNESS_VERSION),
}).strict();
const CodexAdapterSchema = z.object({
  adapterId: z.literal("codex"),
  harnessVersion: z.literal(SCOPE_RUNTIME_CODEX_VERSION),
}).strict();
const AdapterSchema = z.discriminatedUnion("adapterId", [ClaudeAdapterSchema, CodexAdapterSchema]);

/**
 * Signed scope-runtime eligibility is verified against the exact profile and
 * pinned isolated-adapter versions this gateway build ships. The multi-adapter
 * shape is canonical; the legacy single `claude-code` shape is normalized to it.
 */
export const CollaborationAiExecutionEligibilitySchema = z.union([
  ProfileSchema.extend({
    adapters: z.array(AdapterSchema).min(1).max(16)
      .refine((items) => new Set(items.map((item) => item.adapterId)).size === items.length, {
        message: "Duplicate isolated adapter",
      }),
    matrixBot: MatrixBotProfileSchema.optional(),
  }).strict(),
  ProfileSchema.extend(ClaudeAdapterSchema.shape).strict(),
]).transform((value) => "adapters" in value ? value : {
  profileId: value.profileId,
  profileVersion: value.profileVersion,
  profileDigest: value.profileDigest,
  adapters: [{ adapterId: value.adapterId, harnessVersion: value.harnessVersion }],
  matrixBot: undefined,
});

export type CollaborationAiExecutionEligibility = z.output<
  typeof CollaborationAiExecutionEligibilitySchema
>;

export function parseCollaborationAiEligibility(
  value: unknown,
): CollaborationAiExecutionEligibility {
  return CollaborationAiExecutionEligibilitySchema.parse(value);
}

/**
 * Maps an immutable canonical Chat binding to the isolated adapter that executes
 * it. Any `claude_code` Instance (production `claude_code_default` included)
 * executes on the `claude-code` adapter; nothing is remapped to a synthetic
 * Instance. Codex executes only through its single `codex_default` Instance.
 */
export function sharedAiAdapterFor(
  driverKind: CanonicalProviderDriverKind,
  instanceId: string,
): CollaborationAiAdapterId | undefined {
  if (driverKind === "claude_code") return "claude-code";
  if (driverKind === "codex" && instanceId === CODEX_SHARED_INSTANCE_ID) return "codex";
  return undefined;
}

export function sharedAiEligibilitySupportsDriver(
  value: unknown,
  driverKind: CanonicalProviderDriverKind,
  instanceId: string,
): boolean {
  const parsed = CollaborationAiExecutionEligibilitySchema.safeParse(value);
  if (driverKind === "matrix_bot") return parsed.success && instanceId === MATRIX_BOT_INSTANCE_ID && parsed.data.matrixBot !== undefined;
  const adapterId = sharedAiAdapterFor(driverKind, instanceId);
  if (!adapterId) return false;
  return parsed.success && parsed.data.adapters.some((adapter) => adapter.adapterId === adapterId);
}

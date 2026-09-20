import type { CanonicalProviderDriverKind } from "@matrix-os/contracts";
import {
  SCOPE_RUNTIME_CODEX_VERSION,
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "@matrix-os/scope-runtime/profile";
import { z } from "zod/v4";

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
  }).strict(),
  ProfileSchema.extend(ClaudeAdapterSchema.shape).strict(),
]).transform((value) => "adapters" in value ? value : {
  profileId: value.profileId,
  profileVersion: value.profileVersion,
  profileDigest: value.profileDigest,
  adapters: [{ adapterId: value.adapterId, harnessVersion: value.harnessVersion }],
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
  const adapterId = sharedAiAdapterFor(driverKind, instanceId);
  if (!adapterId) return false;
  const parsed = CollaborationAiExecutionEligibilitySchema.safeParse(value);
  return parsed.success && parsed.data.adapters.some((adapter) => adapter.adapterId === adapterId);
}

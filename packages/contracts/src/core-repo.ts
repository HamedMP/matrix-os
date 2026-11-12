import { z } from "zod/v4";

/**
 * Matrix Core repo distribution contract (spec 2691, layer 6), shared by the
 * platform sync job and the VPS / CLI installer. Both sides apply the same
 * archive rules, so a tarball the platform refuses to pin is also one an
 * installer would refuse to extract.
 */
export const CORE_REPO_MAX_TARBALL_BYTES = 50 * 1024 * 1024;
export const CORE_REPO_MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
export const CORE_REPO_MAX_ENTRIES = 5_000;
export const CORE_REPO_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CORE_REPO_DEFAULT_REF = "stable";

export const CoreRepoCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const CoreRepoSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const CoreRepoOrgIdSchema = z.string().regex(/^org_[A-Za-z0-9]{1,124}$/);

export const CoreRepoPinSchema = z.object({
  orgId: CoreRepoOrgIdSchema,
  /** Skill namespace slug: `org-<slug>-<skill>`. */
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/),
  commit: CoreRepoCommitSchema,
  sha256: CoreRepoSha256Schema,
  bytes: z.number().int().positive().max(CORE_REPO_MAX_TARBALL_BYTES),
}).strict();
export type CoreRepoPin = z.infer<typeof CoreRepoPinSchema>;

/**
 * `membership: "verified"` means the platform confirmed every one of the
 * caller's memberships: an org absent from `pins` is confirmed not current
 * (or no longer publishes). Without it, an installer must not remove anything.
 */
export const CoreRepoPinsResponseSchema = z.object({
  pins: z.array(CoreRepoPinSchema).max(100),
  membership: z.literal("verified").optional(),
}).strict();

export const CoreRepoSyncResultSchema = z.object({
  status: z.enum(["pinned", "unchanged", "failed"]),
  commit: CoreRepoCommitSchema.optional(),
}).strict();
export type CoreRepoSyncResult = z.infer<typeof CoreRepoSyncResultSchema>;

/** Lowercase, hyphenated, at most 32 characters; falls back to the org id. */
export function coreRepoSlug(organizationSlug: string, orgId: string): string {
  const cleaned = organizationSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return cleaned || orgId.slice(4, 36).toLowerCase();
}

export function coreRepoSkillNamespace(slug: string): string {
  return `org-${slug}-`;
}

/**
 * Longest installed skill name, `org-<slug>-<name>` combined. The installer
 * and `scripts/sync-matrix-agent-skills.sh` (namespace mode) both enforce it,
 * and report a skill over the limit instead of skipping it silently.
 */
export const CORE_REPO_MAX_SKILL_NAME_LENGTH = 100;

/**
 * The repo-relative path of one archive entry, with the single top-level
 * directory GitHub adds stripped, or "" for that directory itself. Throws for
 * absolute paths, `..`, control characters, backslashes, or a second root.
 */
export function coreRepoEntryPath(raw: string, expectedRoot: { value?: string }): string {
  if (!raw || raw.length > 1_024 || /[\x00-\x1f\x7f\\]/.test(raw) || raw.startsWith("/")) throw new Error("CoreRepoArchiveRejected");
  const parts = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "").split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("CoreRepoArchiveRejected");
  const root = parts.shift()!;
  expectedRoot.value ??= root;
  if (root !== expectedRoot.value) throw new Error("CoreRepoArchiveRejected");
  return parts.join("/");
}

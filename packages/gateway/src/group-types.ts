import { z } from "zod/v4";

export const GROUP_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MEMBER_HANDLE_REGEX = /^@[a-z0-9_]{1,32}:[a-z0-9.-]{1,253}$/;

// ULID: 26 chars, Crockford Base32
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const GroupManifestSchema = z.object({
  room_id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().regex(GROUP_SLUG_REGEX),
  owner_handle: z.string().regex(MEMBER_HANDLE_REGEX),
  joined_at: z.number().int(),
  schema_version: z.number().int().min(1),
});
export type GroupManifest = z.infer<typeof GroupManifestSchema>;

export const GroupAclSchema = z.object({
  read_pl: z.number().int(),
  write_pl: z.number().int(),
  install_pl: z.number().int(),
  policy: z.enum(["open", "moderated", "owner_only"]),
});
export type GroupAcl = z.infer<typeof GroupAclSchema>;

const ChunkSeqSchema = z
  .object({
    index: z.number().int().min(0),
    count: z.number().int().min(1).max(32),
    group_id: z.string().regex(ULID_REGEX),
  })
  .refine((cs) => cs.index < cs.count, {
    message: "chunk_seq.index must be less than chunk_seq.count",
  });

export const OpEventContentSchema = z.object({
  v: z.number().int(),
  update: z.string(),
  lamport: z.number().int(),
  client_id: z.string().min(1),
  origin: z.string().min(1),
  ts: z.number().int(),
  chunk_seq: ChunkSeqSchema.optional(),
});
export type OpEventContent = z.infer<typeof OpEventContentSchema>;

export const SnapshotEventContentSchema = z.object({
  v: z.number().int(),
  snapshot_id: z.string().regex(ULID_REGEX),
  generation: z.number().int(),
  chunk_index: z.number().int().min(0),
  chunk_count: z.number().int().min(1),
  state: z.string(),
  taken_at_event_id: z.string().min(1),
  taken_at: z.number().int(),
  written_by: z.string().min(1),
});
export type SnapshotEventContent = z.infer<typeof SnapshotEventContentSchema>;

export const SnapshotLeaseContentSchema = z.object({
  v: z.number().int(),
  writer: z.string().min(1),
  lease_id: z.string().regex(ULID_REGEX),
  acquired_at: z.number().int(),
  expires_at: z.number().int(),
});
export type SnapshotLeaseContent = z.infer<typeof SnapshotLeaseContentSchema>;

const MAX_DEPTH = 16;
const MAX_SERIALIZED_BYTES = 256 * 1024;

function makeDataValueSchema(depth: number): z.ZodType<unknown> {
  if (depth === 0) {
    return z.union([z.null(), z.string(), z.number(), z.boolean()]);
  }
  const inner: z.ZodType<unknown> = z.lazy(() => makeDataValueSchema(depth - 1));
  return z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(inner),
    z.record(z.string(), inner),
  ]);
}

const _rawDataValueSchema = makeDataValueSchema(MAX_DEPTH);

export const GroupDataValueSchema = _rawDataValueSchema.superRefine((val, ctx) => {
  // Reject non-JSON primitives that z.union may admit (Date, BigInt, functions)
  if (val instanceof Date) {
    ctx.addIssue({ code: "custom", message: "Date is not a valid GroupDataValue" });
    return;
  }
  if (typeof val === "bigint") {
    ctx.addIssue({ code: "custom", message: "BigInt is not a valid GroupDataValue" });
    return;
  }
  if (typeof val === "function") {
    ctx.addIssue({ code: "custom", message: "function is not a valid GroupDataValue" });
    return;
  }
  if (typeof val === "symbol") {
    ctx.addIssue({ code: "custom", message: "symbol is not a valid GroupDataValue" });
    return;
  }
  if (typeof val === "undefined") {
    ctx.addIssue({ code: "custom", message: "undefined is not a valid GroupDataValue" });
    return;
  }
  const serialized = JSON.stringify(val);
  if (Buffer.byteLength(serialized, "utf-8") > MAX_SERIALIZED_BYTES) {
    ctx.addIssue({ code: "custom", message: `GroupDataValue serialized size exceeds ${MAX_SERIALIZED_BYTES} bytes` });
  }
});

const SAFE_APP_SLUG = /^[a-z][a-z0-9_-]{0,62}$/;

export const GroupDataRequestSchema = z
  .object({
    action: z.enum(["read", "write", "list"]),
    app_slug: z.string().regex(SAFE_APP_SLUG),
    key: z.string().optional(),
    value: GroupDataValueSchema.optional(),
  })
  .superRefine((req, ctx) => {
    if (req.action === "read" && req.key === undefined) {
      ctx.addIssue({ code: "custom", message: "key is required for read action" });
    }
    if (req.action === "write" && req.key === undefined) {
      ctx.addIssue({ code: "custom", message: "key is required for write action" });
    }
    if (req.action === "write" && req.value === undefined) {
      ctx.addIssue({ code: "custom", message: "value is required for write action" });
    }
  });
export type GroupDataRequest = z.infer<typeof GroupDataRequestSchema>;

export const CreateGroupBodySchema = z.object({
  name: z.string().min(1),
  member_handles: z.array(z.string().regex(MEMBER_HANDLE_REGEX)).optional(),
});

export const JoinGroupBodySchema = z.object({
  room_id: z.string().min(1),
});

export const ShareAppBodySchema = z.object({
  app_slug: z.string().regex(GROUP_SLUG_REGEX),
});

export const InviteBodySchema = z.object({
  user_id: z.string().regex(MEMBER_HANDLE_REGEX),
});

export const RenameGroupBodySchema = z.object({
  name: z.string().min(1).max(200),
});

export const KickBodySchema = z.object({
  user_id: z.string().regex(MEMBER_HANDLE_REGEX),
});

export const ChangeRoleBodySchema = z.object({
  role: z.enum(["owner", "editor", "viewer"]),
});

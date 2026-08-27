import { z } from "zod/v4";
import { IsoTimestampSchema } from "#contract-primitives";
import {
  CanonicalChatExecutionRootRefSchema,
  canonicalBoundedText,
  canonicalEncodedByteLength,
  canonicalReferenceId,
} from "#canonical-chat-primitives";
import {
  CanonicalChatIdSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatTurnIdSchema,
} from "#canonical-chat";

export const CanonicalChatChangePathSchema = z.string()
  .min(1)
  .max(4_096)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\u0000\r\n]+$/);

export const CanonicalChatTurnChangeFileSchema = z.object({
  path: CanonicalChatChangePathSchema,
  previousPath: CanonicalChatChangePathSchema.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "binary"]),
  additions: z.number().int().min(0).max(1_000_000),
  deletions: z.number().int().min(0).max(1_000_000),
  partial: z.boolean(),
}).strict().superRefine((file, ctx) => {
  if ((file.status === "renamed") !== (file.previousPath !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["previousPath"], message: "Only renamed files require a previous path" });
  }
});

export const CanonicalChatTurnChangeSetSchema = z.object({
  chatId: CanonicalChatIdSchema,
  turnId: CanonicalChatTurnIdSchema,
  runId: CanonicalChatRunIdSchema,
  projectId: canonicalReferenceId(160),
  executionRoot: CanonicalChatExecutionRootRefSchema,
  revision: z.string().regex(/^turnrev_[a-f0-9]{64}$/),
  beforeRevision: z.string().regex(/^tree_[a-f0-9]{40,64}$/),
  afterRevision: z.string().regex(/^tree_[a-f0-9]{40,64}$/),
  source: z.enum(["provider_authoritative", "workspace_checkpoints"]),
  label: z.enum([
    "Exact turn changes",
    "Workspace changes observed during this turn",
    "Concurrent workspace changes observed during this turn",
    "No workspace changes",
  ]),
  concurrent: z.boolean(),
  partial: z.boolean(),
  files: z.array(CanonicalChatTurnChangeFileSchema).max(200),
  totals: z.object({
    changedFileCount: z.number().int().min(0).max(10_000),
    additions: z.number().int().min(0).max(1_000_000),
    deletions: z.number().int().min(0).max(1_000_000),
  }).strict(),
  capturedAt: IsoTimestampSchema,
}).strict().superRefine((changes, ctx) => {
  if (changes.totals.changedFileCount < changes.files.length) {
    ctx.addIssue({ code: "custom", path: ["totals", "changedFileCount"], message: "File count cannot be smaller than the projection" });
  }
  if (changes.source === "provider_authoritative" && changes.label !== "Exact turn changes") {
    ctx.addIssue({ code: "custom", path: ["label"], message: "Provider-authoritative changes require the exact-turn label" });
  }
  if (changes.concurrent !== changes.label.startsWith("Concurrent")) {
    ctx.addIssue({ code: "custom", path: ["concurrent"], message: "Concurrent state and label must agree" });
  }
  if (changes.totals.changedFileCount === 0 && changes.label !== "No workspace changes") {
    ctx.addIssue({ code: "custom", path: ["label"], message: "Empty changes require the no-change label" });
  }
});

export const CanonicalChatTurnChangeSummaryResponseSchema = z.object({
  changes: CanonicalChatTurnChangeSetSchema,
}).strict();

export const CanonicalChatTurnDiffResponseSchema = z.object({
  chatId: CanonicalChatIdSchema,
  turnId: CanonicalChatTurnIdSchema,
  revision: CanonicalChatTurnChangeSetSchema.shape.revision,
  file: CanonicalChatTurnChangeFileSchema.extend({
    hunks: z.array(z.object({
      id: canonicalReferenceId(128),
      oldStart: z.number().int().min(0).max(1_000_000),
      oldLines: z.number().int().min(0).max(1_000_000),
      newStart: z.number().int().min(0).max(1_000_000),
      newLines: z.number().int().min(0).max(1_000_000),
      heading: canonicalBoundedText(120, 480).optional(),
      partial: z.boolean(),
      lines: z.array(z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("context"), oldLine: z.number().int().min(1), newLine: z.number().int().min(1), content: z.string().max(1_000).refine((value) => canonicalEncodedByteLength(value) <= 4_000) }).strict(),
        z.object({ kind: z.literal("add"), newLine: z.number().int().min(1), content: z.string().max(1_000).refine((value) => canonicalEncodedByteLength(value) <= 4_000) }).strict(),
        z.object({ kind: z.literal("remove"), oldLine: z.number().int().min(1), content: z.string().max(1_000).refine((value) => canonicalEncodedByteLength(value) <= 4_000) }).strict(),
      ])).max(120),
    }).strict()).max(100),
  }).strict(),
}).strict();

export const CanonicalChatTurnFileReadQuerySchema = z.object({
  path: CanonicalChatChangePathSchema,
  version: z.enum(["before", "after", "current"]),
}).strict();

export const CanonicalChatTurnFileReadResponseSchema = z.object({
  chatId: CanonicalChatIdSchema,
  turnId: CanonicalChatTurnIdSchema,
  revision: CanonicalChatTurnChangeSetSchema.shape.revision,
  path: CanonicalChatChangePathSchema,
  version: z.enum(["before", "after", "current"]),
  label: z.enum(["Before turn", "After turn", "Current file"]),
  content: canonicalBoundedText(64_000, 256 * 1024),
  encoding: z.literal("utf8"),
  truncated: z.boolean(),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export type CanonicalChatTurnChangeFile = z.infer<typeof CanonicalChatTurnChangeFileSchema>;
export type CanonicalChatTurnChangeSet = z.infer<typeof CanonicalChatTurnChangeSetSchema>;
export type CanonicalChatTurnChangeSummaryResponse = z.infer<typeof CanonicalChatTurnChangeSummaryResponseSchema>;
export type CanonicalChatTurnDiffResponse = z.infer<typeof CanonicalChatTurnDiffResponseSchema>;
export type CanonicalChatTurnFileReadQuery = z.infer<typeof CanonicalChatTurnFileReadQuerySchema>;
export type CanonicalChatTurnFileReadResponse = z.infer<typeof CanonicalChatTurnFileReadResponseSchema>;

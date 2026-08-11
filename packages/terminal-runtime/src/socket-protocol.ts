import {
  ProjectIdSchema,
  SafeDisplayStringSchema,
  TerminalRefSchema,
  TerminalWorkspaceIdSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const RequestIdSchema = z.string().regex(/^req_[0-9a-f]{32}$/);
const RequestBase = { version: z.literal(1), requestId: RequestIdSchema };

export const TerminalRuntimeRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...RequestBase, operation: z.literal("ListWorkspaces"), input: z.object({}).strict() }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("EnsureWorkspace"),
    input: z.object({ projectId: ProjectIdSchema.optional() }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("CreateTab"),
    input: z.object({
      workspaceId: TerminalWorkspaceIdSchema,
      name: SafeDisplayStringSchema,
      cwd: z.string().max(4096),
      command: z.array(z.string().min(1).max(4096)).min(1).max(128).optional(),
      agent: z.object({
        providerId: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
        threadId: z.string().regex(/^thread_[A-Za-z0-9_-]+$/).optional(),
      }).strict().optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("GetSnapshot"),
    input: TerminalRefSchema,
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("RenameTab"),
    input: TerminalRefSchema.extend({
      name: SafeDisplayStringSchema,
      baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("ReorderTabs"),
    input: z.object({
      workspaceId: TerminalWorkspaceIdSchema,
      tabIds: z.array(z.string().regex(/^tt_[0-9a-f]{32}$/)).max(10_000),
      baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }).strict(),
  }).strict(),
  z.object({ ...RequestBase, operation: z.literal("TerminateTab"), input: TerminalRefSchema }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("WriteInput"),
    input: TerminalRefSchema.extend({ data: z.string().min(1).max(64 * 1024) }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("UpdateTabUiState"),
    input: TerminalRefSchema.extend({
      placement: z.enum(["active", "background"]).optional(),
      lastSeenSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
      baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("Resize"),
    input: TerminalRefSchema.extend({
      mode: z.enum(["hard", "soft"]),
      size: z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).strict(),
    }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("DeletionImpact"),
    input: z.object({ workspaceId: TerminalWorkspaceIdSchema }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("DeleteWorkspace"),
    input: z.object({ workspaceId: TerminalWorkspaceIdSchema, confirmTerminate: z.literal(true) }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal("Attach"),
    input: TerminalRefSchema.extend({
      viewerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
      fromSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      mode: z.enum(["hard", "soft"]),
      size: z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).strict(),
    }).strict(),
  }).strict(),
]);

export const TerminalRuntimeResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    version: z.literal(1),
    requestId: RequestIdSchema,
    ok: z.literal(true),
    result: z.unknown(),
  }).strict(),
  z.object({
    version: z.literal(1),
    requestId: RequestIdSchema.optional(),
    ok: z.literal(false),
    error: z.object({
      code: z.enum(["invalid_request", "not_found", "conflict", "unavailable", "failed"]),
      message: z.string().min(1).max(128),
    }).strict(),
  }).strict(),
]);

export type TerminalRuntimeRequest = z.infer<typeof TerminalRuntimeRequestSchema>;
export type TerminalRuntimeResponse = z.infer<typeof TerminalRuntimeResponseSchema>;

import { z } from "zod/v4";

export const TICKET_BODY_LIMIT = 64 * 1024;
export const MAX_TICKET_LIST_LIMIT = 200;

export const TicketSourceKindSchema = z.enum(["linear", "matrix"]);
export const TicketSyncStatusSchema = z.enum(["local", "synced", "pending", "conflict"]);
export const TicketPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export const TicketIdSchema = z.string().regex(/^ticket_[A-Za-z0-9_-]{1,128}$/);
export const TicketStatusSchema = z.string().trim().min(1).max(64);
export const TicketTextIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:@/-]+$/);

const StringListSchema = z.array(TicketTextIdSchema).max(64).default([]);

export const TrackedTicketSchema = z.object({
  id: TicketIdSchema,
  projectSlug: z.string().trim().min(1).max(128),
  sourceKind: TicketSourceKindSchema,
  sourceId: z.string().trim().min(1).max(256),
  sourceUrl: z.string().url().optional(),
  identifier: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).default(""),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  assigneeIds: StringListSchema,
  labelIds: StringListSchema,
  dependencyIds: StringListSchema,
  artifactIds: StringListSchema,
  syncStatus: TicketSyncStatusSchema,
  revision: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().default(null),
  deletedAt: z.string().nullable().default(null),
});

export const CreateInternalTicketSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).default(""),
  status: TicketStatusSchema.default("Todo"),
  priority: TicketPrioritySchema.default("medium"),
  assigneeIds: StringListSchema,
  labelIds: StringListSchema,
  dependencyIds: StringListSchema,
  artifactIds: StringListSchema,
});

export const ExternalTicketInputSchema = CreateInternalTicketSchema.extend({
  sourceKind: z.literal("linear"),
  sourceId: z.string().trim().min(1).max(256),
  sourceUrl: z.string().url().optional(),
  identifier: z.string().trim().min(1).max(128),
});

export const TicketPatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20_000).optional(),
  status: TicketStatusSchema.optional(),
  priority: TicketPrioritySchema.optional(),
  assigneeIds: z.array(TicketTextIdSchema).max(64).optional(),
  labelIds: z.array(TicketTextIdSchema).max(64).optional(),
  dependencyIds: z.array(TicketTextIdSchema).max(64).optional(),
  artifactIds: z.array(TicketTextIdSchema).max(64).optional(),
});

export const UpdateTicketSchema = z.object({
  baseRevision: z.number().int().min(1),
  patch: TicketPatchSchema,
});

export const TicketListQuerySchema = z.object({
  source: z.enum(["linear", "matrix", "all"]).default("all"),
  status: TicketStatusSchema.optional(),
  assigneeId: TicketTextIdSchema.optional(),
  cursor: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TICKET_LIST_LIMIT).default(100),
  includeArchived: z.coerce.boolean().default(false),
}).passthrough();

export const LinearSyncSchema = z.object({
  sourceId: TicketTextIdSchema,
  mode: z.enum(["preview", "sync"]).default("sync"),
});

export type TicketSourceKind = z.infer<typeof TicketSourceKindSchema>;
export type TicketSyncStatus = z.infer<typeof TicketSyncStatusSchema>;
export type TrackedTicket = z.infer<typeof TrackedTicketSchema>;
export type CreateInternalTicketInput = z.infer<typeof CreateInternalTicketSchema>;
export type ExternalTicketInput = z.infer<typeof ExternalTicketInputSchema>;
export type UpdateTicketInput = z.infer<typeof UpdateTicketSchema>;
export type TicketListQuery = z.infer<typeof TicketListQuerySchema>;

export interface TicketListPage {
  tickets: TrackedTicket[];
  nextCursor: string | null;
}

export interface TicketSyncSummary {
  created: number;
  updated: number;
  unchanged: number;
  truncated: boolean;
}

export function ticketError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

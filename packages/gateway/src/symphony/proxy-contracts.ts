import { z } from "zod/v4";

export const SymphonyIssueIdentifierSchema = z.string().min(1).max(80).regex(/^[A-Z][A-Z0-9]{1,12}-[0-9]{1,10}$/);
export const SymphonyRunIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const EmptyProxyBodySchema = z.object({}).strict();

const ElixirRunningEntrySchema = z.object({
  issue_identifier: z.string().optional(),
  issue_id: z.string().optional(),
  state: z.string().optional(),
  session_id: z.string().optional().nullable(),
  turn_count: z.number().int().nonnegative().optional(),
  last_event: z.string().optional().nullable(),
  last_message: z.string().optional().nullable(),
  started_at: z.string().optional().nullable(),
  last_event_at: z.string().optional().nullable(),
}).passthrough();

const ElixirRetryEntrySchema = z.object({
  issue_identifier: z.string().optional(),
  issue_id: z.string().optional(),
  attempt: z.number().int().nonnegative().optional(),
  due_at: z.string().optional().nullable(),
  error: z.unknown().optional(),
}).passthrough();

export const ElixirStateSchema = z.object({
  generated_at: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  running: z.array(ElixirRunningEntrySchema).optional(),
  retrying: z.array(ElixirRetryEntrySchema).optional(),
}).passthrough();

export const ElixirIssueSchema = z.object({
  issue_identifier: z.string().optional(),
  issue_id: z.string().optional().nullable(),
  status: z.string().optional(),
  workspace: z.object({ path: z.string().optional() }).passthrough().optional(),
  running: z.object({
    session_id: z.string().optional().nullable(),
    turn_count: z.number().int().nonnegative().optional(),
    last_event: z.string().optional().nullable(),
    last_message: z.string().optional().nullable(),
  }).passthrough().optional().nullable(),
  retry: z.object({
    attempt: z.number().int().nonnegative().optional(),
    due_at: z.string().optional().nullable(),
    error: z.unknown().optional(),
  }).passthrough().optional().nullable(),
  logs: z.unknown().optional(),
  recent_events: z.array(z.unknown()).optional(),
}).passthrough();

export const ElixirRefreshSchema = z.object({
  requested_at: z.string().optional(),
}).passthrough();

export const ElixirStopSchema = z.object({
  stopped: z.literal(true).optional(),
  stopped_at: z.string().optional(),
}).passthrough();

export function genericProxyError(code: string, message: string) {
  return { error: { code, message } };
}

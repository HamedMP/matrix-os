import { z } from "zod/v4";

/** Stable recipient-facing failure codes shared by the platform, home, and renderers. */
export const CollaborationFailureCodeSchema = z.enum([
  "unavailable", "host_offline", "upgrade_required", "relay_limit", "not_found",
  "forbidden", "resource_missing", "paused",
]);
export type CollaborationFailureCode = z.infer<typeof CollaborationFailureCodeSchema>;

export const CollaborationFailureResponseSchema = z.object({
  error: z.string().max(120),
  code: CollaborationFailureCodeSchema,
  retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
}).strict();

/** Fallback for route errors that predate the typed collaboration mappers. */
export function collaborationHttpFailureCode(status: number, error?: string): string {
  if (status === 503) return error === "host_offline" ? "host_offline" : "unavailable";
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  if (status === 401) return "unauthorized";
  if (status === 426) return "upgrade_required";
  if (status === 423) return "paused";
  if (status === 429) return error === "relay_limit" ? "relay_limit" : "rate_limited";
  if (status === 409) return "conflict";
  return "invalid_request";
}

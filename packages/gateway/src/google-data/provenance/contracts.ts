import { z } from "zod/v4";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const entityKind = z.enum(["chat", "session", "import", "attachment", "derived"]);
export type GoogleEntityKind = z.infer<typeof entityKind>;
export const originSchema = z.object({
  connectionId: opaque, profileId: opaque,
  profileRevision: z.number().int().positive().max(2_147_483_647),
  purpose: opaque,
}).strict();
export type GoogleOrigin = z.infer<typeof originSchema>;
export const copySchema = z.object({
  ownerId: opaque, kind: entityKind, entityRef: opaque,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  origins: z.array(originSchema).min(1).max(32),
  retention: z.object({ choice: z.literal("until"), deadline: z.iso.datetime(), decisionId: opaque }).strict(),
  baseRevision: z.number().int().positive().optional(),
}).strict();
export type RecordGoogleCopy = z.infer<typeof copySchema>;
export function validateOpaque(value: string): string { return opaque.parse(value); }
export class GoogleProvenanceUnavailable extends Error {
  constructor() { super("Google data unavailable"); this.name = "GoogleProvenanceUnavailable"; }
}
export interface GoogleCopy {
  id: string; ownerId: string; kind: GoogleEntityKind; entityRef: string;
  contentHash: string; origins: GoogleOrigin[]; revision: number;
  retentionDeadline: string; retentionDecisionId: string;
  state: "active" | "purging" | "deleted";
}
export interface PurgeClaim {
  jobId: string; ownerId: string; leaseToken: string; revision: number;
}
export type PurgeOutcome = { status: "deleted" | "missing" | "modified" | "unavailable" };
/** Trusted adapters MUST atomically compare owner+hash and delete, with idempotent missing handling.
 * Respect the abort signal and never delete a changed or foreign copy. No handler is installed by default.
 * This contract covers registered managed copies only, not provider/backups/unregistered copies. */
export type PurgeHandlers = Partial<Record<GoogleEntityKind, (input: {
  ownerId: string; entityRef: string; expectedHash: string; signal: AbortSignal;
}) => Promise<PurgeOutcome>>>;
export interface ProvenanceLimits {
  maxEntities: number; maxEntitiesPerOwner: number; maxJobs: number; maxRequests: number;
  maxAttempts: number; retryDelayMs: number; handlerTimeoutMs: number;
}
export const defaults: ProvenanceLimits = {
  maxEntities: 200_000, maxEntitiesPerOwner: 10_000, maxJobs: 20_000,
  maxRequests: 20_000, maxAttempts: 5, retryDelayMs: 60_000, handlerTimeoutMs: 30_000,
};
export function limits(input: Partial<ProvenanceLimits>): ProvenanceLimits {
  const value = { ...defaults, ...input };
  for (const [key, number] of Object.entries(value)) {
    if (!Number.isSafeInteger(number) || number < (key === "retryDelayMs" ? 0 : 1) || number > defaults[key as keyof ProvenanceLimits]) throw new GoogleProvenanceUnavailable();
  }
  return value;
}
export const originKey = (origin: GoogleOrigin) => JSON.stringify([origin.connectionId, origin.profileId, origin.profileRevision, origin.purpose]);

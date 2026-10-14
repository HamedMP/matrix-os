import { z } from "zod/v4";

export const OWNER_APP_READ_PATH = "/api/agent/app-data/read";
export const OWNER_APP_READ_TOOL = "read_app_data";
export const OWNER_APP_READ_DEFAULT_ROWS = 50;
export const OWNER_APP_READ_MAX_ROWS = 100;
export const OWNER_APP_READ_MAX_BYTES = 64 * 1024;
export const OWNER_APP_READ_BODY_BYTES = 16 * 1024;
const name = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const boundedRecord = <T extends z.ZodType>(value: T) => z.record(name, value).refine(v => Object.keys(v).length <= 16);
const scalar = z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()]);
const ordered = z.union([z.string().max(2048), z.number().finite()]);
const operator = z.strictObject({
  $eq: scalar.optional(), $ne: scalar.optional(), $lt: ordered.optional(), $lte: ordered.optional(),
  $gt: ordered.optional(), $gte: ordered.optional(), $in: z.array(scalar).max(100).optional(),
  $like: z.string().max(2048).optional(), $ilike: z.string().max(2048).optional(),
}).refine(v => Object.keys(v).length > 0);
export const OwnerAppReadInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("listApps") }),
  z.strictObject({ action: z.literal("schema"), app: name }),
  z.strictObject({ action: z.literal("find"), app: name, table: name,
    filter: boundedRecord(z.union([scalar, operator])).optional(),
    orderBy: boundedRecord(z.enum(["asc", "desc"])).optional(),
    limit: z.number().int().min(1).max(OWNER_APP_READ_MAX_ROWS).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
  }),
]);
export type OwnerAppReadInput = z.infer<typeof OwnerAppReadInputSchema>;
export const OwnerAppReadGrantSchema = z.strictObject({
  runtimeHandle: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),
  apps: z.array(z.strictObject({ app: name, schema: name,
    tables: z.array(name).min(1).max(32).refine(v => new Set(v).size === v.length),
  })).max(64),
}).refine(v => new Set(v.apps.map(app => app.app)).size === v.apps.length);
export type OwnerAppReadGrant = z.infer<typeof OwnerAppReadGrantSchema>;
export interface OwnerAppReadAuditEvent {
  ownerId?: string; runId?: string; runtimeHandle?: string; app?: string;
  action?: "listApps" | "schema" | "find";
  outcome: "allowed" | "denied" | "error";
}
export type OwnerAppReadAudit = (event: OwnerAppReadAuditEvent) => Promise<void>;

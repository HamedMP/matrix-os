/**
 * Content-free usage contract shared by every Matrix Core MCP entry point.
 * A record names who called which tool through which path and how it ended;
 * it never carries arguments, results, or upstream error text.
 */
import { z } from "zod/v4";

export const CoreEntryPointSchema = z.enum(["stdio", "managed_pi", "external_mcp", "unknown"]);
export type CoreEntryPoint = z.infer<typeof CoreEntryPointSchema>;
export const CoreHarnessSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export const CORE_USAGE_OUTCOMES = ["ok", "error", "denied", "approval_required", "timeout", "cancelled"] as const;
export type CoreUsageOutcome = typeof CORE_USAGE_OUTCOMES[number];

export interface CoreUsageRecord {
  orgId: string | null;
  actorId: string;
  connectionId: string;
  serverKey: string;
  toolName: string;
  entryPoint: CoreEntryPoint;
  harness: string | null;
  outcome: CoreUsageOutcome;
  latencyMs: number;
  occurredAt: Date;
}

/** Must never throw or block: usage is off the call path. */
export interface CoreUsageSink {
  record(row: CoreUsageRecord): void;
}

/** A coarse server identity for aggregates: the preset id or the URL host, never a path or query. */
export function coreServerKey(server: { url: string; presetId?: string | null }): string {
  if (server.presetId) return `preset:${server.presetId}`.slice(0, 128);
  try { return new URL(server.url).hostname.slice(0, 128) || "unknown"; }
  catch (error: unknown) {
    console.warn("[core-mcp] server URL unparseable for usage key", error instanceof Error ? error.name : "UnknownError");
    return "unknown";
  }
}

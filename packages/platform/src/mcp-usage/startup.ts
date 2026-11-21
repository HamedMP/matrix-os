/**
 * Composition for the Matrix Core MCP inside the platform process: the one
 * broker instance gains the Core tool service and a usage writer backed by
 * platform Postgres. Kept out of platform-startup.ts to bound that file.
 */
import type { Kysely } from "kysely";
import { bootstrapMcpUsageDatabase, createMcpUsageRepository, type McpUsageDatabase, type McpUsageEventRow } from "./database.js";
import { createMcpUsageWriter, startMcpUsageMaintenance } from "./writer.js";

export interface GatewayCoreToolsModule {
  CoreToolService: new (options: { broker: unknown; approvals?: unknown; usage?: { record(row: McpUsageEventRow): void }; orgPolicy?: unknown }) => unknown;
}

export async function createPlatformCoreMcp(options: {
  db: Kysely<McpUsageDatabase>;
  coreModule: GatewayCoreToolsModule;
  broker: unknown;
  approvals: unknown;
  /** Call-time org governance (spec 2691 layer 5); absent when organizations are not configured. */
  orgPolicy?: unknown;
  /** Rollup/retention run on one worker class only; every instance writes rows. */
  maintenance: boolean;
}): Promise<{ core: unknown; shutdown(): Promise<void> }> {
  await bootstrapMcpUsageDatabase(options.db);
  const repository = createMcpUsageRepository(options.db);
  const writer = createMcpUsageWriter({ insert: rows => repository.insertEvents(rows) });
  writer.start();
  const maintenance = options.maintenance ? startMcpUsageMaintenance({ repository }) : undefined;
  const core = new options.coreModule.CoreToolService({ broker: options.broker, approvals: options.approvals, usage: writer,
    ...(options.orgPolicy ? { orgPolicy: options.orgPolicy } : {}) });
  let closing: Promise<void> | undefined;
  return {
    core,
    shutdown: () => closing ??= (async () => {
      await maintenance?.stop();
      await writer.drain();
      const stats = writer.stats();
      if (stats.dropped || stats.failed) console.warn("[mcp-usage] shutdown with unwritten usage rows", { dropped: stats.dropped, failed: stats.failed });
    })(),
  };
}

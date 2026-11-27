/**
 * Composition for the Matrix Core MCP inside the platform process: the one
 * broker instance gains the Core tool service and a usage writer backed by
 * platform Postgres. Kept out of platform-startup.ts to bound that file.
 */
import type { Kysely } from "kysely";
import { bootstrapMcpUsageDatabase, createMcpUsageRepository, type McpUsageDatabase, type McpUsageEventRow } from "./database.js";
import { createMcpUsageWriter, startMcpUsageMaintenance } from "./writer.js";

export interface GatewayCoreToolsModule {
  CoreToolService: new (options: { broker: unknown; approvals?: unknown; usage?: { record(row: McpUsageEventRow): void }; orgPolicy?: unknown; apps?: unknown }) => unknown;
}

/** The gateway Connect Apps adapter (spec 2691); Pipedream stays platform-owned and is passed in. */
export interface GatewayCoreConnectedAppsModule {
  createCoreConnectedApps(options: { db: unknown; pipedream: unknown; outlookGraph?: unknown; outlookLegacyRetired?: boolean }): unknown;
}

interface CoreServiceSlugs { serviceSlugs(userId: string): Promise<Map<string, string>> }

export async function createPlatformCoreMcp(options: {
  db: Kysely<McpUsageDatabase>;
  coreModule: GatewayCoreToolsModule;
  broker: unknown;
  approvals: unknown;
  /** Call-time org governance (spec 2691 layer 5); absent when organizations are not configured. */
  orgPolicy?: unknown;
  /** Rollup/retention run on one worker class only; every instance writes rows. */
  maintenance: boolean;
  /** Settings -> Connect Apps in Core. */
  connectedApps?: { module: GatewayCoreConnectedAppsModule; db: unknown; pipedream: unknown; outlookGraph?: unknown; outlookLegacyRetired?: boolean };
}): Promise<{ core: unknown; serviceSlugs(userId: string): Promise<Map<string, string>>; shutdown(): Promise<void> }> {
  await bootstrapMcpUsageDatabase(options.db);
  const repository = createMcpUsageRepository(options.db);
  const writer = createMcpUsageWriter({ insert: rows => repository.insertEvents(rows) });
  writer.start();
  const maintenance = options.maintenance ? startMcpUsageMaintenance({ repository }) : undefined;
  const apps = options.connectedApps?.module.createCoreConnectedApps({
    db: options.connectedApps.db, pipedream: options.connectedApps.pipedream,
    outlookGraph: options.connectedApps.outlookGraph, outlookLegacyRetired: options.connectedApps.outlookLegacyRetired });
  const core = new options.coreModule.CoreToolService({ broker: options.broker, approvals: options.approvals, usage: writer,
    ...(options.orgPolicy ? { orgPolicy: options.orgPolicy } : {}), ...(apps ? { apps } : {}) });
  let closing: Promise<void> | undefined;
  return {
    core,
    serviceSlugs: userId => (core as CoreServiceSlugs).serviceSlugs(userId),
    shutdown: () => closing ??= (async () => {
      await maintenance?.stop();
      await writer.drain();
      const stats = writer.stats();
      if (stats.dropped || stats.failed) console.warn("[mcp-usage] shutdown with unwritten usage rows", { dropped: stats.dropped, failed: stats.failed });
    })(),
  };
}

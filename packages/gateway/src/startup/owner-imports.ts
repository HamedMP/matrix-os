import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import { fileURLToPath } from "node:url";
import { AppGalleryCatalogSchema } from "@matrix-os/contracts/app-gallery";
import { createBotIntegrationClient, type BotIntegrationTransport } from "../bots/integration-client.js";
import { pinDirectory, readLimited, readTemplate, DEFAULT_LIMITS } from "../app-gallery/filesystem.js";
import { upgradeGalleryStarters, type LegacyGalleryTemplate } from "../app-gallery/sync-upgrade.js";
import { readOwnerManifest } from "../app-gallery/owner-index.js";
import { GallerySyncRepository } from "../app-gallery/sync-repository.js";
import { GallerySyncService } from "../app-gallery/sync-service.js";
import { createGallerySyncRoutes } from "../app-gallery/sync-routes.js";
import { createRuntimeDataImportRoutes } from "./data-imports.js";
import type { Dispatcher } from "../dispatcher.js";

/** Extracted owner-import composition owns the worker; the caller owns the injected pool. */
export async function registerOwnerImports(app: Hono, options: {
  ownerDatabase: Kysely<any> | null; homePath: string; runtimeOwnerIds: readonly string[];
  transport: BotIntegrationTransport | null; dispatcher: Dispatcher;
}) {
  app.route("/api/data-imports", await createRuntimeDataImportRoutes(options));
  let service: GallerySyncService | null = null;
  if (options.ownerDatabase && options.transport) {
    const db = options.ownerDatabase;
    const repository = new GallerySyncRepository(db); await repository.bootstrap();
    const client = createBotIntegrationClient(options.transport);
    const catalog = async () => AppGalleryCatalogSchema.parse(JSON.parse((await readLimited(fileURLToPath(new URL("../../../../home/system/app-gallery.json", import.meta.url)), 256 * 1024)).toString("utf8"))).apps;
    try {
      const upgraded = await upgradeGalleryStarters({ homePath: options.homePath, apps: await catalog(),
        files: await readTemplate(fileURLToPath(new URL("../../../../home/app-templates/connected-starter", import.meta.url)), DEFAULT_LIMITS),
        legacy: JSON.parse((await readLimited(fileURLToPath(new URL("../../../../home/system/gallery-starter-legacy.json", import.meta.url)), 256 * 1024)).toString("utf8")) as LegacyGalleryTemplate,
      });
      console.info("[gallery-sync] Starter upgrades", upgraded);
    } catch (error) { console.error("[gallery-sync] Starter upgrade unavailable; owner files preserved", error); }
    service = new GallerySyncService({ repository, ownerIds: options.runtimeOwnerIds,
      catalog,
      installed: async id => {
        const owner = await pinDirectory(options.homePath);
        let apps, directory;
        try {
          apps = await owner.child("apps"); directory = await apps.child(id);
          const { manifest } = await readOwnerManifest(directory);
          return manifest?.slug === id;
        } catch (error) {
          if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))) return false;
          throw error;
        } finally { await directory?.close(); await apps?.close(); await owner.close(); }
      },
      inventory: (owner, signal) => client.inventory(owner, signal),
      dispatch: (...args) => options.dispatcher.dispatch(...args),
      probe: async (owner, selection, signal) => {
        if (!selection.accounts.every(a => a.service === "gmail")) return null;
        const versions: Record<string, string> = {};
        for (const account of selection.accounts) {
          const { data } = await client.callImportRead(owner, { service: "gmail", action: "get_profile", label: account.label, connectionId: account.connectionId, params: {} }, signal);
          if (!data || typeof data !== "object" || !("historyId" in data) || typeof data.historyId !== "string" || !/^\d{1,64}$/.test(data.historyId)
            || account.expectedEmail !== null && (!("emailAddress" in data) || data.emailAddress !== account.expectedEmail)) throw new Error("Mailbox change check unavailable");
          versions[account.connectionId] = data.historyId;
        }
        return Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)));
      },
      records: async (appId, runId, startedAt) => {
        // appId is revalidated against the immutable bundled catalog before each run.
        const result = await sql<{ added: string; updated: string }>`SELECT
          count(*) FILTER (WHERE created_at >= ${startedAt}) AS added,
          count(*) FILTER (WHERE created_at < ${startedAt}) AS updated
          FROM ${sql.table(`${appId}.records`)} WHERE payload->>'importRunId' = ${runId} AND payload->>'archivedAt' IS NULL`.execute(db);
        return { added: Number(result.rows[0]?.added ?? 0), updated: Number(result.rows[0]?.updated ?? 0) };
      },
    });
    service.startWorker();
  }
  app.route("/api/app-gallery", createGallerySyncRoutes({ service, ownerIds: options.runtimeOwnerIds }));
  return { close: async () => { await service?.close(); } };
}

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import { requireRequestPrincipal } from "../request-principal.js";
import { createBotIntegrationClient, type BotIntegrationTransport } from "../bots/integration-client.js";
import type { RefreshBinding } from "../integrations/refresh/contracts.js";
import { IntegrationRefreshRepository } from "../integrations/refresh/repository.js";
import { IntegrationRefreshService } from "../integrations/refresh/service.js";
import { createIntegrationRefreshRoutes } from "../integrations/refresh/routes.js";
import { readRefreshWithDeadline } from "../integrations/refresh/deadline.js";

const integrationRef = z.string().max(200).regex(/^[a-z][a-z0-9_]{1,99}(?:\.[a-z][a-z0-9_]{0,99})?$/);
const manifestSchema = z.object({ name: z.string().min(1).max(200), integrations: z.object({
  required: z.array(integrationRef).max(100).default([]), optional: z.array(integrationRef).max(100).default([]),
}) });
const inside = (home: string, path: string) => { const rel = relative(home, path); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };

/** An installed manifest supplies permission; a caller cannot supply a permission document. */
async function declaresService(homePath: string, binding: RefreshBinding): Promise<boolean> {
  const home = await realpath(homePath);
  const apps = join(home, "apps"); const directory = join(apps, binding.appId); const file = join(directory, "matrix.json");
  try {
    for (const path of [apps, directory]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(home, await realpath(path))) return false;
    }
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 65536) return false;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536 || stat.dev !== before.dev || stat.ino !== before.ino || !inside(home, await realpath(file))) return false;
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) return false;
      const manifest = manifestSchema.safeParse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      // The service-level read risk is checked by IntegrationRefreshService.
      // A dotted write/send permission must not become a generic read grant.
      return manifest.success && [...manifest.data.integrations.required, ...manifest.data.integrations.optional]
        .some(ref => ref === binding.service || ref === `${binding.service}.read` || ref === `${binding.service}.${binding.action}`);
    } finally { await handle.close(); }
  } catch (error: unknown) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code)))) return false;
    throw error;
  }
}

/** Owner-local routes. This repository never owns or destroys the injected database pool. */
export async function createRuntimeDataImportRoutes(options: {
  ownerDatabase: Kysely<any> | null;
  homePath: string;
  runtimeOwnerIds: readonly string[];
  transport: BotIntegrationTransport | null;
}): Promise<Hono> {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // Sandboxed generated-app cookies authenticate /apps only. They are not owner API credentials.
    if (c.req.header("origin") === "null" || c.get("appSession" as never)) return c.json({ error: "Forbidden" }, 403);
    try {
      if (!options.runtimeOwnerIds.includes(requireRequestPrincipal(c).userId)) return c.json({ error: "Forbidden" }, 403);
    } catch (error: unknown) {
      console.warn("[data-imports] Principal rejected:", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  });
  if (!options.ownerDatabase || !options.transport) {
    app.use("*", bodyLimit({ maxSize: 32768 }));
    app.all("*", c => c.json({ error: "Data import is unavailable" }, 503));
    return app;
  }
  const repository = new IntegrationRefreshRepository(options.ownerDatabase);
  await repository.bootstrap();
  const client = createBotIntegrationClient(options.transport);
  const authorizeApp = async (ownerId: string, binding: RefreshBinding) =>
    options.runtimeOwnerIds.includes(ownerId) && declaresService(options.homePath, binding);
  const authorizeConnection = async (ownerId: string, binding: RefreshBinding, signal: AbortSignal) => {
    if (!options.runtimeOwnerIds.includes(ownerId)) return false;
    const inventory = await readRefreshWithDeadline(bounded => client.inventory(ownerId, bounded), signal, 10000);
    const selected = inventory.filter(connection => connection.service === binding.service && connection.label === binding.label);
    return selected.length === 1 && selected[0]!.connectionId === binding.connectionId;
  };
  const service = new IntegrationRefreshService({ repository, authorizeApp, authorizeConnection,
    read: async ({ ownerId, binding, params, signal }) => {
      const result = await client.call(ownerId, { service: binding.service, action: binding.action,
        label: binding.label, connectionId: binding.connectionId, params, read: true }, signal);
      return result.data;
    },
  });
  app.route("/", createIntegrationRefreshRoutes({ service, resolveOwner: async c => requireRequestPrincipal(c).userId }));
  return app;
}

import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { createHostedBotsDriveApproval } from "./drive-approval.js";

export const HOSTED_BOTS_DRIVE_SOCKET = "/run/matrix-openmausbot-drive/drive.sock";
export const HOSTED_BOTS_DRIVE_BASE = "/api/hosted-bots/drive";
export const HOSTED_BOTS_INTEGRATIONS_BASE = "/api/hosted-bots/integrations";

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

async function removeStaleSocket(path: string, ownerUid: number): Promise<void> {
  const existing = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== ownerUid) throw new Error("Unexpected Drive socket entry");
  const isStale = await new Promise<boolean>((resolve, reject) => {
    const connection = createConnection(path);
    connection.once("connect", () => { connection.destroy(); resolve(false); });
    connection.once("error", (error) => {
      if (errorCode(error) === "ECONNREFUSED") resolve(true);
      else reject(error);
    });
    connection.setTimeout(1_000, () => connection.destroy(new Error("Drive socket check timed out")));
  });
  if (!isStale) throw new Error("Drive socket already serving");
  await unlink(path);
}

export async function bindHostedBotsDriveSocket(path: string, app: Hono): Promise<() => Promise<void>> {
  // The service creates this directory outside the workload's writable mount.
  // Verify ownership before creating a listener or removing a stale socket.
  const ownerUid = process.getuid?.();
  const directory = await lstat(dirname(path));
  if (ownerUid === undefined || !directory.isDirectory() || directory.uid !== ownerUid
    || (directory.mode & 0o027) !== 0) throw new Error("Drive socket directory is not protected");
  await removeStaleSocket(path, ownerUid);

  const server = createAdaptorServer({
    fetch: app.fetch,
    createServer,
    serverOptions: {
      requestTimeout: 5_000, headersTimeout: 5_000, keepAliveTimeout: 1_000,
      maxHeaderSize: 4_096, connectionsCheckingInterval: 1_000,
    },
  }) as Server;
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.on("error", (error) => {
    console.warn("[hosted-bots-drive] Socket failed", errorCode(error) ?? error.name);
  });
  const close = async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    await chmod(path, 0o660);
  } catch (error: unknown) {
    await close();
    throw error;
  }
  return close;
}

export async function initializeHostedBotsDrive(options: Parameters<typeof createHostedBotsDriveApproval>[0]
  & { socketPath?: string }) {
  if (!options.admitted) return { routes: new Hono(), integrationRoutes: new Hono(), close: async () => {} };
  if ((options.github || options.integration) && options.ownerId) {
    const broker = createHostedBotsDriveApproval(options);
    try {
      const stop = await bindHostedBotsDriveSocket(options.socketPath ?? HOSTED_BOTS_DRIVE_SOCKET, broker.guestRoutes);
      return { routes: broker.ownerRoutes, integrationRoutes: broker.integrationOwnerRoutes, close: async () => { broker.close(); await stop(); } };
    } catch (error: unknown) {
      broker.close();
      console.warn("[hosted-bots-drive] Could not start Drive broker", errorCode(error) ?? (error instanceof Error ? error.name : "UnknownError"));
    }
  }
  const unavailable = new Hono();
  unavailable.all("*", (c) => {
    c.header("cache-control", "no-store");
    return options.isOwner(c) ? c.json({ error: "unavailable" }, 503) : c.json({ error: "forbidden" }, 403);
  });
  return { routes: unavailable, integrationRoutes: unavailable, close: async () => {} };
}

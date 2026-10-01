/** Extracted gateway composition for local imports; injected owner DB and primary store stay gateway-owned. */
import type { Context, Hono } from "hono";
import type { RequestPrincipal } from "../../request-principal.js";
import type { R2Client } from "../../sync/r2-client.js";
import type { ChatRepository } from "../repository.js";
import { LocalChatImportJobs } from "./jobs.js";
import { LocalChatImportPublisher } from "./publication.js";
import { createLocalChatImportRoutes } from "./routes.js";
import { createLocalChatImportWorker } from "./worker.js";
export function registerLocalChatImports(options: { app: Hono; repository: ChatRepository | null; storage?: R2Client | null;
  runtimeOwnerId?: string; runtimeSlot?: string; getPrincipal(context: Context): RequestPrincipal }) {
  const ownerId = options.runtimeOwnerId?.trim();
  const available = Boolean(options.repository && options.storage && ownerId);
  const jobs = available ? new LocalChatImportJobs({ repository: options.repository!, storage: options.storage!, runtimeOwnerId: ownerId!, runtimeSlot: options.runtimeSlot }) : null;
  const publisher = available ? new LocalChatImportPublisher({ repository: options.repository!, runtimeOwnerId: ownerId!, storage: {
    getPresignedGetUrl: (key, expires) => options.storage!.getPresignedGetUrl(key, expires),
    putObject: (key, bytes) => options.storage!.putObject(key, bytes, { contentLength: bytes.byteLength, signal: AbortSignal.timeout(30_000) }),
    deleteObject: key => options.storage!.deleteObject(key),
  } }) : null;
  const worker = available ? createLocalChatImportWorker({
    async sweep() { await jobs!.recoverPending(); await jobs!.expire(); await publisher!.sweepPrivateArtifacts(); },
    async step(signal) {
      const row = await options.repository!.kysely.selectFrom("local_chat_import_jobs").select("id").where("owner_id", "=", ownerId!)
        .where("expires_at", ">", new Date()).where(eb => eb.or([
          eb("status", "=", "uploaded"), eb.and([eb("status", "=", "verifying"), eb("lease_expires_at", "<=", new Date())]),
        ])).orderBy("created_at").limit(1).executeTakeFirst();
      if (!row || signal.aborted) return false;
      try { await publisher!.publish({ type: "personal", ownerId: ownerId! }, row.id, signal); }
      catch (error: unknown) { if (!signal.aborted) console.warn("[chat/import] publication unavailable", error instanceof Error ? error.name : "UnknownError"); }
      return true;
    },
  }) : null;
  options.app.route("/", createLocalChatImportRoutes({ jobs, publisher, wake: () => worker?.wake(), getPrincipal: options.getPrincipal }));
  worker?.wake();
  return { async close() { await worker?.close(); } };
}

import { createServer, request } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { createFilePreviewService } from "../../../../packages/gateway/src/file-preview-service";
import { registerFileRoutes } from "../../../../packages/gateway/src/server/file-routes";
import { pickerCatalog } from "./chat-picker-catalog";
import { startStubGateway } from "./stub-gateway";

const time = "2026-11-18T00:00:00.000Z";
const chat = {
  id: "chat_files_review",
  title: "Chat Files review",
  ownerScope: { type: "personal", ownerId: "user-1" },
  lifecycle: "active",
  attention: "none",
  messageCount: 0,
  revision: 1,
  createdAt: time,
  updatedAt: time,
};
export const MATRIX_ATTACH_FILE = "attachment-fixture.txt";
export const MATRIX_TRASH_FOLDER = "trash-fixture-folder";
export const MATRIX_TRASH_CHILD = "isolated file contents\n";

export async function startChatFilesReviewGateway() {
  const homePath = await mkdtemp(join(tmpdir(), "chat-files-review-"));
  const stub = await startStubGateway();
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== "Bearer stub-token-1") return c.json({ error: "Unauthorized" }, 401);
    await next();
  });
  registerFileRoutes(app, {
    homePath,
    getPrincipal: () => ({ userId: "user-1", source: "dev-default" }),
    filePreviewService: createFilePreviewService({
      homePath,
      canAccessHome: principal => principal.userId === "user-1",
      resolveProjectRoot: async () => null,
    }),
  });
  await writeFile(join(homePath, MATRIX_ATTACH_FILE), "isolated attachment contents\n", { flag: "wx" });
  await mkdir(join(homePath, MATRIX_TRASH_FOLDER));
  await writeFile(join(homePath, MATRIX_TRASH_FOLDER, "child.txt"), MATRIX_TRASH_CHILD, { flag: "wx" });
  const gatewayRequire = createRequire(new URL("../../../../packages/gateway/package.json", import.meta.url));
  const { getRequestListener } = gatewayRequire("@hono/node-server") as typeof import("@hono/node-server");
  const fileListener = getRequestListener(app.fetch);
  const catalog = pickerCatalog();
  catalog.instances[0]!.supports.attachments = ["file", "image"];
  const record = { chat };

  const server = createServer((req, res) => {
    const target = new URL(req.url ?? "/", stub.url);
    const { pathname } = target;
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (pathname.startsWith("/api/files/") || pathname.startsWith("/api/file-previews/")) {
      void fileListener(req, res);
      return;
    }
    if (pathname === "/api/chat-providers") return json(catalog);
    if (pathname === "/api/chat-agents") return json({ enabled: true, agents: [] });
    if (pathname === "/api/chats") return json({ items: [record] });
    if (pathname === `/api/chats/${chat.id}/bot`) return json({ agentId: null });
    if (pathname === `/api/chats/${chat.id}/read-state`) return json(record);
    if (pathname === `/api/chats/${chat.id}`) return json({ record, messages: [], runs: [], turns: [], activities: [], queuedTurns: [] });
    const upstream = request(target, { method: req.method, headers: req.headers, timeout: 10_000 }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Fixture timeout")));
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    homePath,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await stub.close();
      await rm(homePath, { recursive: true, force: true });
    },
  };
}

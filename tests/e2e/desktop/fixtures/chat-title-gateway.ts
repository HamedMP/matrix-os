import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { startStubGateway } from "./stub-gateway";

export const LONG_CHAT_TITLE = "我想设计一个个人主页。请先用 request_user_input 工具询问我喜欢的视觉风格，提供三个选项和简短说明。".repeat(3);
export const SHORT_CHAT_TITLE = "Brief";
export const FAILED_CHAT_TITLE = "Failed conversation with a long title ".repeat(4);
export const TITLE_CHAT_ID = "chat_title_layout";

export async function startChatTitleGateway() {
  const base = await startStubGateway();
  let title = LONG_CHAT_TITLE;
  let revision = 1;
  const record = () => ({ chat: {
    id: TITLE_CHAT_ID, title, revision, ownerScope: { type: "personal", ownerId: "user-1" },
    lifecycle: "active", attention: "none", messageCount: 0,
    createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
  } });
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, base.url).pathname;
    const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/api/chats") return json({ items: [record(),
      { chat: { ...record().chat, id: "chat_short", title: SHORT_CHAT_TITLE } },
      { chat: { ...record().chat, id: "chat_failed", title: FAILED_CHAT_TITLE, attention: "failed",
          userState: { pinned: true, muted: false, readThroughSeq: 0 } },
        readState: { unread: true, markedUnread: true, version: 1, readThroughSeq: 0, latestIncomingSeq: 0 } },
    ] });
    if (path === `/api/chats/${TITLE_CHAT_ID}`) return json({ record: record(), messages: [], runs: [], turns: [], activities: [], queuedTurns: [] });
    if (path === `/api/chats/${TITLE_CHAT_ID}/title` && req.method === "PATCH") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString());
      title = input.title; revision += 1;
      return json(record());
    }
    const upstream = request(new URL(req.url!, base.url), { method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.setTimeout(10_000, () => upstream.destroy(new Error("Fixture timeout")));
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, getTitle: () => title,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await base.close(); } };
}

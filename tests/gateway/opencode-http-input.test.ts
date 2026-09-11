import { createServer, type ServerResponse } from "node:http";
import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AgentThreadEvent, AgentThreadSummary } from "@matrix-os/contracts";
import { createOpenCodeCodingAgentProvider } from "../../packages/gateway/src/coding-agents/opencode-provider.js";
import { createOpenCodeServerProcess, OPENCODE_READ_ONLY_PERMISSIONS } from "../../packages/gateway/src/coding-agents/opencode-server-process.js";

describe("OpenCode HTTP input round trip", () => {
  it("keeps the same session alive until the real HTTP reply is acknowledged", async () => {
    let authorization = ""; let stream: ServerResponse | undefined; let prompt: ServerResponse | undefined;
    let replies = 0; let prompts = 0; let submitted: unknown;
    const server = createServer(async (req, res) => {
      if (!authorization || req.headers.authorization !== authorization) { res.writeHead(401).end(); return; }
      expect(req.headers["x-opencode-directory"]).toBe(encodeURIComponent("/work/repo"));
      let body = ""; for await (const chunk of req) body += chunk;
      res.setHeader("content-type", "application/json");
      if (req.url === "/session" || req.url === "/session/ses_http") {
        res.end(JSON.stringify({ id: "ses_http", directory: "/work/repo", permission: OPENCODE_READ_ONLY_PERMISSIONS })); return;
      }
      if (req.url === "/event") {
        res.setHeader("content-type", "text/event-stream"); res.flushHeaders(); stream = res;
        res.write('data: {"type":"server.connected","properties":{}}\n\n'); return;
      }
      if (req.url === "/session/ses_http/message") {
        prompts++; prompt = res;
        expect(JSON.parse(body)).toMatchObject({ model: { providerID: "anthropic", modelID: "claude-sonnet-5" } });
        stream!.write(`data: ${JSON.stringify({ type: "question.asked", properties: { id: "que_http", sessionID: "ses_http", questions: [{ header: "Color", question: "Pick a color", options: [{ label: "Red", description: "Warm" }], custom: true }] } })}\n\n`);
        return;
      }
      if (req.url === "/question/que_http/reply") {
        replies++; submitted = JSON.parse(body);
        stream!.write(`data: ${JSON.stringify({ type: "question.replied", properties: { sessionID: "ses_http", requestID: "que_http", answers: [["Green"]] } })}\n\n`);
        // Native run completion can race ahead of the reply HTTP acknowledgement.
        prompt!.end(JSON.stringify({ info: { role: "assistant" }, parts: [{ id: "part_http", type: "text", text: "Green selected", time: { end: 1 } }] }));
        setTimeout(() => res.end("true"), 20); return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Test server missing");
    const native = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (signal: NodeJS.Signals) => void };
    native.stdout = new EventEmitter(); native.stderr = new EventEmitter();
    native.kill = () => { server.closeAllConnections(); queueMicrotask(() => native.emit("exit", 0)); };
    const adapter = createOpenCodeCodingAgentProvider({
      homePath: "/owner", resolveProjectPath: async () => "/work/repo", resolveCredentialLaunch: async () => ({ env: {} }),
      spawnFn: (command, args, options) => createOpenCodeServerProcess(command, args, options, { spawn: (_command, _args, spawnOptions) => {
        authorization = `Basic ${Buffer.from(`opencode:${spawnOptions.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
        queueMicrotask(() => native.stdout.emit("data", Buffer.from(`opencode server listening on http://127.0.0.1:${address.port}\n`)));
        return native as never;
      } }),
    });
    const thread: AgentThreadSummary = { id: "thread_http_input", providerId: "opencode", title: "Question", status: "queued", attention: "none", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const principal = { userId: "owner", source: "jwt" as const }; let sequence = 0;
    const context = { principal, thread, now: () => new Date(), nextEventId: () => `evt_http_${++sequence}` };
    const observed: AgentThreadEvent[] = [];
    try {
      const running = Promise.resolve(adapter.startThread({ ...context, request: { providerId: "opencode", projectId: "project", prompt: "Ask my favorite color", model: "anthropic:claude-sonnet-5", sandboxMode: "read_only", clientRequestId: "req_http_start" }, publishEvents: batch => { observed.push(...batch.events); } }));
      await vi.waitFor(() => expect(observed.some(event => event.type === "user_input.requested")).toBe(true));
      const input = observed.find(event => event.type === "user_input.requested")!;
      if (input.type !== "user_input.requested") throw new Error("Question missing");
      await adapter.submitInput!({ ...context, inputRequestId: input.request.requestId, request: { clientRequestId: "req_http_reply", correlationId: input.request.correlationId, answer: "Green", structuredAnswers: { q0: ["Green"] } } });
      const result = await running;
      expect(result.resumeState?.conversationId).toContain("ses_http");
      expect(observed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "assistant.text.delta", delta: "Green selected" }), expect.objectContaining({ type: "user_input.answered", reason: "answered" })]));
      expect({ prompts, replies, submitted }).toEqual({ prompts: 1, replies: 1, submitted: { answers: [["Green"]] } });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

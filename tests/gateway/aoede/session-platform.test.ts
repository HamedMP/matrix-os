import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { describe, it, expect } from "vitest";
import { createAoedePlatformClient, loadAoedePlatformClient } from "../../../packages/gateway/src/aoede/platform-client.js";
import { loadPlatformSpeechRuntimeConfig } from "../../../packages/gateway/src/speech/platform-client.js";

describe("Aoede runtime transport", () => {
  it("is disabled without validated speech runtime and never falls back to Gemini", () => {
    expect(loadAoedePlatformClient({ MATRIX_HANDLE: "test", GEMINI_API_KEY: "unused" })).toBeUndefined();
    expect(() => loadAoedePlatformClient({ MATRIX_PLATFORM_SPEECH_ENABLED: "true" })).toThrow();
  });

  it("uses runtime auth and slot for bounded mint/attach/close; accepts immediate sideband events", async () => {
    const server = createServer();
    const ws = new WebSocketServer({ server });
    const requests: { path: string; auth?: string; body?: any }[] = [];
    server.on("request", async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      requests.push({ path: req.url!, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.method === "POST" ? { providerSessionId: "live_test", sdp: "answer" } : { ok: true }));
    });
    ws.on("connection", (socket, req) => {
      requests.push({ path: req.url!, auth: req.headers.authorization });
      socket.send(JSON.stringify({ type: "session.started", session: { id: "live_test" } }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port");
    const env = { MATRIX_PLATFORM_SPEECH_ENABLED: "true", MATRIX_PLATFORM_SPEECH_ORIGIN: `http://127.0.0.1:${address.port}`,
      MATRIX_HANDLE: "test", MATRIX_CLERK_USER_ID: "owner", MATRIX_MACHINE_ID: "machine", MATRIX_RUNTIME_SLOT: "main",
      MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: "a".repeat(64) };
    const config = loadPlatformSpeechRuntimeConfig(env)!;
    const client = createAoedePlatformClient(config);
    let sideband: Awaited<ReturnType<typeof client.attach>> | undefined;
    try {
      expect(await client.mint({ clientRequestId: "00000000-0000-4000-8000-000000000001", sdp: "offer", instructions: "Be brief",
        input: [{ role: "user", text: "hello", offset: 0 }] })).toEqual({ providerSessionId: "live_test", sdp: "answer" });
      let resolveEvent!: (e: unknown) => void;
      const event = new Promise((resolve) => { resolveEvent = resolve; });
      sideband = await client.attach("live_test", resolveEvent, () => {});
      expect(await event).toMatchObject({ type: "session.started" });
      await client.close("live_test");
      expect(requests.map((r) => r.path)).toEqual([
        "/internal/containers/test/aoede/session?runtimeSlot=main",
        "/internal/containers/test/aoede/sessions/live_test/attach?runtimeSlot=main",
        "/internal/containers/test/aoede/sessions/live_test?runtimeSlot=main",
      ]);
      expect(requests.every((r) => r.auth === `Bearer ${env.MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN}`)).toBe(true);
      expect(requests[0].body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
    } finally {
      sideband?.close(); for (const socket of ws.clients) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => server.close(() => resolve())));
    }
  });
});

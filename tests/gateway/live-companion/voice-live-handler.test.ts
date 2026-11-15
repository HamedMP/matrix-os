import { describe, expect, it, vi } from "vitest";
import { createVoiceLiveHandler } from "../../../packages/gateway/src/live-companion/voice-live-handler.js";
import type { VoiceMediaAdapter } from "../../../packages/gateway/src/voice-session/adapter.js";

const principal = { userId: "alice", source: "jwt" as const };

function harness(overrides: Partial<Parameters<typeof createVoiceLiveHandler>[0]> = {}) {
  const mediaClose = vi.fn(async () => undefined);
  const adapter: VoiceMediaAdapter = { id: "fake", capabilities: {} as VoiceMediaAdapter["capabilities"],
    start: vi.fn(async () => ({ setCapture: vi.fn(), pushAudio: vi.fn(), interrupt: vi.fn(), close: mediaClose })) };
  const resolveChat = vi.fn(async () => ({ chatId: "chat_voice", selection: { instanceId: "matrix_pi_default", model: "m" }, created: false }));
  const createPort = vi.fn(() => ({ journal: vi.fn(), delegate: vi.fn(), search: vi.fn(), restore: vi.fn(), status: vi.fn() }));
  const handler = createVoiceLiveHandler({ adapter, resolveChat, createPort, limits: { maxSessionMs: 60_000, idleMs: 60_000 }, maxSessions: 2, ...overrides });
  const socket = () => ({ sent: [] as Array<Record<string, unknown>>, closed: false,
    send(text: string) { this.sent.push(JSON.parse(text)); }, close() { this.closed = true; } });
  return { handler, adapter, resolveChat, createPort, socket, mediaClose };
}

describe("voice live handler", () => {
  it("binds the call to the resolved Chat and the Matrix Pi selection", async () => {
    const { handler, socket, resolveChat, createPort } = harness();
    const ws = socket();
    const connection = handler.connect(principal, { chatId: undefined }, ws);
    await connection.ready;
    expect(resolveChat).toHaveBeenCalledWith(principal, undefined);
    expect(createPort).toHaveBeenCalledWith(principal, expect.objectContaining({ chatId: "chat_voice" }));
    expect(ws.sent[0]).toEqual({ type: "session.ready", chatId: "chat_voice" });
  });

  it("replaces an owner's earlier call instead of running two", async () => {
    const { handler, socket, mediaClose } = harness();
    const first = socket();
    await handler.connect(principal, {}, first).ready;
    await handler.connect(principal, {}, socket()).ready;
    expect(first.sent.at(-1)).toEqual({ type: "session.ended", reason: "replaced" });
    expect(first.closed).toBe(true);
    expect(mediaClose).toHaveBeenCalledOnce();
    expect(handler.activeCount).toBe(1);
  });

  it("refuses new owners past the session cap", async () => {
    const { handler, socket } = harness({ maxSessions: 1 });
    await handler.connect(principal, {}, socket()).ready;
    const ws = socket();
    await handler.connect({ userId: "bob", source: "jwt" }, {}, ws).ready;
    expect(ws.sent).toEqual([{ type: "error", code: "session_limit_reached", retryable: true }]);
    expect(ws.closed).toBe(true);
  });

  it("maps Chat and route failures to generic codes", async () => {
    const missing = Object.assign(new Error("Chat chat_x not found"), { name: "ChatNotFoundError" });
    const { handler, socket } = harness({ resolveChat: vi.fn(async () => { throw missing; }) });
    const ws = socket();
    await handler.connect(principal, { chatId: "chat_x" }, ws).ready;
    expect(ws.sent).toEqual([{ type: "error", code: "chat_unavailable", retryable: false }]);
    expect(ws.closed).toBe(true);
    expect(handler.activeCount).toBe(0);
  });

  it("drops frames that arrive before the call is ready and drains every call on shutdown", async () => {
    const { handler, socket, mediaClose } = harness();
    const ws = socket();
    const connection = handler.connect(principal, {}, ws);
    await connection.message(JSON.stringify({ type: "capture.start" }));
    await connection.ready;
    await handler.closeAll();
    expect(mediaClose).toHaveBeenCalledOnce();
    expect(ws.sent.at(-1)).toEqual({ type: "session.ended", reason: "shutdown" });
    expect(handler.activeCount).toBe(0);
  });

  it("releases the slot when the socket closes", async () => {
    const { handler, socket } = harness();
    const connection = handler.connect(principal, {}, socket());
    await connection.ready;
    await connection.closed();
    expect(handler.activeCount).toBe(0);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createVocalHandler, type VocalOutbound } from "../../../packages/gateway/src/vocal/ws-handler.js";

interface MockGeminiClient {
  events: Map<string, (evt: unknown) => void>;
  on: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  sendAudio: ReturnType<typeof vi.fn>;
  sendToolResponse: ReturnType<typeof vi.fn>;
}

const geminiMock = vi.hoisted(() => ({
  clients: [] as MockGeminiClient[],
  resolveConnects: [] as Array<() => void>,
}));

vi.mock("../../../packages/gateway/src/onboarding/gemini-live.js", () => ({
  createGeminiLiveClient: vi.fn(() => {
    const events = new Map<string, (evt: unknown) => void>();
    const client = {
      events,
      on: vi.fn((event: string, handler: (evt: unknown) => void) => {
        events.set(event, handler);
      }),
      connect: vi.fn(() => new Promise<void>((resolve) => {
        geminiMock.resolveConnects.push(resolve);
      })),
      close: vi.fn(),
      sendText: vi.fn(),
      sendAudio: vi.fn(),
      sendToolResponse: vi.fn(),
    };
    geminiMock.clients.push(client);
    return client;
  }),
}));

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 50; i += 1) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  }
  throw new Error("condition was not met");
}

describe("vocal websocket handler", () => {
  let homePath: string;
  let sent: VocalOutbound[];

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "vocal-ws-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
    sent = [];
    geminiMock.clients.length = 0;
    geminiMock.resolveConnects.length = 0;
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("closes a stale Gemini client when start re-enters before connect finishes", async () => {
    const h = createVocalHandler({
      homePath,
      geminiApiKey: "test-gemini-key",
      geminiModel: "test-model",
    });
    h.onOpen((msg) => sent.push(msg));

    const firstStart = h.onMessage(JSON.stringify({ type: "start", audioFormat: "pcm16" }));
    await waitFor(() => geminiMock.clients.length === 1);

    const secondStart = h.onMessage(JSON.stringify({ type: "start", audioFormat: "pcm16" }));
    await waitFor(() => geminiMock.clients.length === 2);
    await waitFor(() => geminiMock.resolveConnects.length === 2);

    expect(geminiMock.clients[0].close).toHaveBeenCalled();

    geminiMock.resolveConnects[0]();
    geminiMock.resolveConnects[1]();
    await Promise.all([firstStart, secondStart]);

    expect(sent.filter((msg) => msg.type === "ready")).toHaveLength(1);
    expect(geminiMock.clients[0].sendText).not.toHaveBeenCalled();
    expect(geminiMock.clients[1].sendText).toHaveBeenCalledOnce();
  });
});

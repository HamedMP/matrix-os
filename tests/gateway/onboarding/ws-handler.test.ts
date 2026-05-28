import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createOnboardingHandler } from "../../../packages/gateway/src/onboarding/ws-handler.js";
import type { GatewayToShell } from "../../../packages/gateway/src/onboarding/types.js";

const geminiMock = vi.hoisted(() => ({
  clients: [] as Array<{
    on: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    sendText: ReturnType<typeof vi.fn>;
    sendAudio: ReturnType<typeof vi.fn>;
    sendToolResponse: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../../../packages/gateway/src/onboarding/gemini-live.js", () => ({
  hasGeminiLiveConnection: vi.fn((connection: unknown) => {
    if (!connection) return false;
    if (typeof connection === "string") return connection.length > 0;
    if (typeof connection === "object" && "proxy" in connection) {
      const proxy = (connection as { proxy?: { platformUrl?: string; handle?: string; token?: string } }).proxy;
      return Boolean(proxy?.platformUrl && proxy.handle && proxy.token);
    }
    return false;
  }),
  createGeminiLiveClient: vi.fn(() => {
    const client = {
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      sendText: vi.fn(),
      sendAudio: vi.fn(),
      sendToolResponse: vi.fn(),
    };
    geminiMock.clients.push(client);
    return client;
  }),
}));

describe("onboarding websocket handler", () => {
  let homePath: string;
  let sent: GatewayToShell[];

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "onboarding-ws-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
    sent = [];
    geminiMock.clients.length = 0;
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_AUTH", "");
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function handler(geminiApiKey = "") {
    const h = createOnboardingHandler({
      homePath,
      geminiApiKey,
      geminiModel: "test-model",
    });
    return h;
  }

  it("routes the API-key activation path to api_key without completing onboarding", async () => {
    const h = handler();
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "start", audioFormat: "text" }));
    await h.onMessage(JSON.stringify({ type: "choose_activation", path: "api_key" }));

    expect(sent).toContainEqual({ type: "stage", stage: "api_key" });
    expect(existsSync(join(homePath, "system/onboarding-complete.json"))).toBe(false);
  });

  it("allows explicit Claude Code activation to complete onboarding", async () => {
    const h = handler();
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "start", audioFormat: "text" }));
    await h.onMessage(JSON.stringify({ type: "choose_activation", path: "claude_code" }));

    expect(sent).toContainEqual({ type: "stage", stage: "done" });
    expect(existsSync(join(homePath, "system/onboarding-complete.json"))).toBe(true);
  });

  it("sends a gemini_unavailable notice when voice is requested but no Gemini key is configured", async () => {
    const h = handler();
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "start", audioFormat: "pcm16" }));

    expect(geminiMock.clients).toHaveLength(0);
    expect(sent).toContainEqual({ type: "mode_change", mode: "text" });
    const notice = sent.find((m) => m.type === "notice");
    expect(notice).toBeDefined();
    expect(notice).toMatchObject({
      type: "notice",
      code: "gemini_unavailable",
    });
    expect((notice as { message: string }).message).toMatch(/GEMINI_API_KEY/);
  });

  it("does not send a gemini_unavailable notice when the user explicitly chose text mode", async () => {
    const h = handler();
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "start", audioFormat: "text" }));

    expect(sent.find((m) => m.type === "notice")).toBeUndefined();
  });

  it("closes an existing Gemini client before handling a duplicate start", async () => {
    const h = handler("test-gemini-key");
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "start", audioFormat: "pcm16" }));
    expect(geminiMock.clients).toHaveLength(1);
    expect(geminiMock.clients[0].close).not.toHaveBeenCalled();

    await h.onMessage(JSON.stringify({ type: "start", audioFormat: "text" }));

    expect(geminiMock.clients[0].close).toHaveBeenCalledOnce();
    expect(geminiMock.clients).toHaveLength(1);
    expect(sent).toContainEqual({ type: "mode_change", mode: "text" });
  });
});

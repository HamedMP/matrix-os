import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const setVoiceContext = vi.hoisted(() => vi.fn());

vi.mock("../../packages/gateway/src/channels/telegram.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/channels/telegram.js")>();
  return {
    ...actual,
    createTelegramAdapter: () => ({
      id: "telegram" as const,
      setVoiceContext,
      getBot: () => null,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      onMessage: vi.fn(),
    }),
  };
});

const { initializeGatewayChannels } = await import("../../packages/gateway/src/startup/channels.js");

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  setVoiceContext.mockReset();
});

describe("managed speech gateway process wiring", () => {
  it("keeps shared client composition in the focused runtime module", async () => {
    const [serverSource, runtimeSource] = await Promise.all([
      readFile("packages/gateway/src/server.ts", "utf8"),
      readFile("packages/gateway/src/speech/gateway-runtime.ts", "utf8"),
    ]);
    expect(runtimeSource.includes("createManagedOwnerAudioTranscriber({ client, converter })")).toBe(true);
    expect(runtimeSource.includes("createManagedChannelSttProvider({ client, converter })")).toBe(true);
    expect(serverSource.includes("ownerAudioTranscriber: speechRuntime.ownerAudioTranscriber")).toBe(true);
    // The Telegram voice context is wired inside startup/channels.ts; server.ts
    // only has to hand the managed channel STT to that startup call. The call
    // itself is covered behaviourally below.
    expect(serverSource.includes("channelStt: speechRuntime.channelStt")).toBe(true);
    expect(serverSource).not.toContain("createManagedOwnerAudioTranscriber");
    expect(serverSource).not.toContain("createManagedChannelSttProvider");
  });

  it("gives the Telegram adapter the managed channel STT during channel startup", () => {
    const homePath = mkdtempSync(join(tmpdir(), "managed-speech-channels-"));
    homes.push(homePath);
    const channelStt = { transcribe: vi.fn() } as never;

    initializeGatewayChannels({
      homePath,
      configPath: join(homePath, "system", "channels.json"),
      dispatcher: { dispatch: vi.fn() } as never,
      conversations: {} as never,
      codingAgentThreadStore: undefined,
      codingAgentNotificationPreferenceStore: {} as never,
      finalizeWithSummary: vi.fn(async () => undefined),
      logBestEffortFailure: vi.fn(),
      channelStt,
    });

    expect(setVoiceContext).toHaveBeenCalledWith({ homePath, stt: channelStt });
  });
});

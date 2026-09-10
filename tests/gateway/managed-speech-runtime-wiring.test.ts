import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("managed speech gateway process wiring", () => {
  it("shares the configured platform client with kernel owner audio and Telegram voice notes", async () => {
    const source = await readFile("packages/gateway/src/server.ts", "utf8");
    expect(source.includes("createManagedOwnerAudioTranscriber({ client: platformSpeechClient")).toBe(true);
    expect(source.includes("createManagedChannelSttProvider({ client: platformSpeechClient")).toBe(true);
    expect(source.includes("ownerAudioTranscriber: managedOwnerAudioTranscriber")).toBe(true);
    expect(source.includes("telegramAdapter.setVoiceContext({ homePath, stt: managedChannelStt })")).toBe(true);
  });
});

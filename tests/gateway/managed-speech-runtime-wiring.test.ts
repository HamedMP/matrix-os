import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("managed speech gateway process wiring", () => {
  it("keeps shared client composition in the focused runtime module", async () => {
    const [serverSource, runtimeSource] = await Promise.all([
      readFile("packages/gateway/src/server.ts", "utf8"),
      readFile("packages/gateway/src/speech/gateway-runtime.ts", "utf8"),
    ]);
    expect(runtimeSource.includes("createManagedOwnerAudioTranscriber({ client, converter })")).toBe(true);
    expect(runtimeSource.includes("createManagedChannelSttProvider({ client, converter })")).toBe(true);
    expect(serverSource.includes("ownerAudioTranscriber: speechRuntime.ownerAudioTranscriber")).toBe(true);
    expect(serverSource.includes("telegramAdapter.setVoiceContext({ homePath, stt: speechRuntime.channelStt })")).toBe(true);
    expect(serverSource).not.toContain("createManagedOwnerAudioTranscriber");
    expect(serverSource).not.toContain("createManagedChannelSttProvider");
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("platform speech process wiring", () => {
  it("loads operator policy and composes the configured service before mounting routes", async () => {
    const source = await readFile("packages/platform/src/platform-startup.ts", "utf8");
    expect(source).toContain("loadPlatformSpeechConfig(process.env)");
    expect(source).toContain("createConfiguredPlatformSpeechService({ db, config: speechConfig })");
    expect(source).not.toContain("const speechService: PlatformSpeechService = createUnavailablePlatformSpeechService");
  });
});

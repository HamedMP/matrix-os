import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("local speech stack launcher", () => {
  it("starts platform, gateway and shell while stripping platform speech secrets from non-platform processes", async () => {
    const rootPackage = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
    expect(rootPackage.scripts?.["dev:speech"]).toBe("bash scripts/dev-speech-stack.sh");
    const script = await readFile("scripts/dev-speech-stack.sh", "utf8");
    expect(script).toContain("--filter '@matrix-os/platform' dev");
    expect(script).toContain("--filter '@matrix-os/gateway' dev");
    expect(script).toContain("--filter './shell' dev");
    expect(script.match(/env -u PLATFORM_SPEECH_OPENAI_API_KEY -u PLATFORM_SPEECH_SECRET/g)).toHaveLength(2);
  });
});

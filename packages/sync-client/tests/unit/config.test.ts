import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveConfig } from "../../src/lib/config.js";

describe("saveConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-config-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes config.json with owner-only permissions", async () => {
    const configPath = join(tempDir, "private", "config.json");

    await saveConfig({
      gatewayUrl: "https://alice.matrix-os.com",
      platformUrl: "https://platform.matrix-os.com",
      syncPath: "/tmp/matrix",
      gatewayFolder: "",
      peerId: "mbp",
      pauseSync: false,
    }, configPath);

    expect(JSON.parse(await readFile(configPath, "utf8")).gatewayUrl).toBe(
      "https://alice.matrix-os.com",
    );
    expect((await stat(join(tempDir, "private"))).mode & 0o777).toBe(0o700);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });
});

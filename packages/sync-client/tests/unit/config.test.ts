import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_GATEWAY_URL,
  DEFAULT_PLATFORM_URL,
  defaultGatewayUrl,
  defaultPlatformUrl,
  generatePeerId,
  normalizeGatewayFolder,
  resolveSyncPathWithinHome,
  saveConfig,
} from "../../src/lib/config.js";

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

describe("default URL constants and functions", () => {
  afterEach(() => {
    delete process.env.MATRIXOS_PLATFORM_URL;
    delete process.env.MATRIXOS_GATEWAY_URL;
  });

  it("DEFAULT_PLATFORM_URL and DEFAULT_GATEWAY_URL are app.matrix-os.com", () => {
    expect(DEFAULT_PLATFORM_URL).toBe("https://app.matrix-os.com");
    expect(DEFAULT_GATEWAY_URL).toBe("https://app.matrix-os.com");
  });

  it("defaultPlatformUrl returns the constant when env is unset", () => {
    delete process.env.MATRIXOS_PLATFORM_URL;
    expect(defaultPlatformUrl()).toBe(DEFAULT_PLATFORM_URL);
  });

  it("defaultPlatformUrl returns the env override when set", () => {
    process.env.MATRIXOS_PLATFORM_URL = "http://localhost:9000";
    expect(defaultPlatformUrl()).toBe("http://localhost:9000");
  });

  it("defaultGatewayUrl returns the constant when env is unset", () => {
    delete process.env.MATRIXOS_GATEWAY_URL;
    expect(defaultGatewayUrl()).toBe(DEFAULT_GATEWAY_URL);
  });

  it("defaultGatewayUrl returns the env override when set", () => {
    process.env.MATRIXOS_GATEWAY_URL = "http://localhost:4000";
    expect(defaultGatewayUrl()).toBe("http://localhost:4000");
  });
});

describe("sync-client config helpers", () => {
  it("adds randomness to generated peer IDs to avoid hostname collisions", () => {
    const peerId = generatePeerId();

    expect(peerId).toMatch(/^[a-z0-9.-]+-[a-f0-9]{8}$/);
  });

  it("normalizes safe gateway folders", () => {
    expect(normalizeGatewayFolder("projects/./2026//")).toBe("projects/2026");
  });

  it("rejects gatewayFolder traversal", () => {
    expect(() => normalizeGatewayFolder("../etc")).toThrow("..");
  });

  it("keeps syncPath within the user's home directory", () => {
    expect(resolveSyncPathWithinHome("projects", "/Users/alice")).toBe("/Users/alice/projects");
    expect(() => resolveSyncPathWithinHome("/etc", "/Users/alice")).toThrow(
      "syncPath must stay within your home directory",
    );
  });
});

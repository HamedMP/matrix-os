import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  validateApiKeyFormat,
  validateApiKeyLive,
  storeApiKey,
  hasApiKey,
} from "../../../packages/gateway/src/onboarding/api-key.js";

describe("API key validation and storage", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "api-key-test-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("validateApiKeyFormat", () => {
    it("accepts key starting with sk-ant-", () => {
      const result = validateApiKeyFormat("sk-ant-abc123");
      expect(result).toEqual({ valid: true });
    });

    it("rejects empty string", () => {
      const result = validateApiKeyFormat("");
      expect(result).toEqual({ valid: false, error: expect.any(String) });
    });

    it("rejects key with wrong prefix", () => {
      const result = validateApiKeyFormat("sk-wrong-abc123");
      expect(result).toEqual({ valid: false, error: expect.any(String) });
    });
  });

  describe("validateApiKeyLive", () => {
    it("returns valid when API returns 200", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const result = await validateApiKeyLive("sk-ant-test123");
      expect(result).toEqual({ valid: true });
    });

    it("returns invalid when API returns non-200", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      const result = await validateApiKeyLive("sk-ant-test123");
      expect(result.valid).toBe(false);
      expect(result).toHaveProperty("error");
    });

    it("returns invalid on network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
      const result = await validateApiKeyLive("sk-ant-test123");
      expect(result.valid).toBe(false);
    });

    it("redacts API key in error messages", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Failed for sk-ant-secret123")),
      );
      await validateApiKeyLive("sk-ant-secret123");
      const loggedMsg = consoleSpy.mock.calls[0]?.[0] ?? "";
      expect(loggedMsg).not.toContain("sk-ant-secret123");
      expect(loggedMsg).toContain("[REDACTED]");
    });

    it("uses AbortSignal.timeout", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);
      await validateApiKeyLive("sk-ant-test");
      const call = mockFetch.mock.calls[0];
      expect(call[1].signal).toBeDefined();
    });
  });

  describe("storeApiKey", () => {
    it("stores key in config.json under kernel.anthropicApiKey", async () => {
      writeFileSync(join(homePath, "system/config.json"), "{}");
      await storeApiKey(homePath, "sk-ant-stored");
      const config = JSON.parse(readFileSync(join(homePath, "system/config.json"), "utf-8"));
      expect(config.kernel.anthropicApiKey).toBe("sk-ant-stored");
    });

    it("preserves existing config keys", async () => {
      writeFileSync(
        join(homePath, "system/config.json"),
        JSON.stringify({ channels: { telegram: {} } }),
      );
      await storeApiKey(homePath, "sk-ant-test");
      const config = JSON.parse(readFileSync(join(homePath, "system/config.json"), "utf-8"));
      expect(config.channels).toEqual({ telegram: {} });
      expect(config.kernel.anthropicApiKey).toBe("sk-ant-test");
    });

    it("creates config if it does not exist", async () => {
      rmSync(join(homePath, "system/config.json"), { force: true });
      await storeApiKey(homePath, "sk-ant-new");
      const config = JSON.parse(readFileSync(join(homePath, "system/config.json"), "utf-8"));
      expect(config.kernel.anthropicApiKey).toBe("sk-ant-new");
    });
  });

  describe("hasApiKey", () => {
    it("returns true when key is stored", async () => {
      writeFileSync(
        join(homePath, "system/config.json"),
        JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-x" } }),
      );
      expect(await hasApiKey(homePath)).toBe(true);
    });

    it("returns false when no key", async () => {
      writeFileSync(join(homePath, "system/config.json"), "{}");
      expect(await hasApiKey(homePath)).toBe(false);
    });

    it("returns false when config does not exist", async () => {
      expect(await hasApiKey(homePath + "/nonexistent")).toBe(false);
    });
  });
});

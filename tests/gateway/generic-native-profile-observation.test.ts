import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { observeGenericNativeProfile, createGenericNativeProfileObserver } from "../../packages/gateway/src/ai-providers/generic-native-profile-observation.js";

const now = new Date("2026-09-26T00:00:00Z");
async function fixture(harness: "pi" | "opencode") {
  const homePath = await mkdtemp(join(tmpdir(), "native-profile-observation-"));
  const configDir = join(homePath, harness === "pi" ? ".pi/agent" : ".config/opencode");
  const authDir = join(homePath, harness === "pi" ? ".pi/agent" : ".local/share/opencode");
  await mkdir(configDir, { recursive: true }); await mkdir(authDir, { recursive: true });
  const configPath = join(configDir, harness === "pi" ? "settings.json" : "opencode.json");
  const authPath = join(authDir, "auth.json");
  await writeFile(configPath, JSON.stringify(harness === "pi" ? { defaultProvider: "b", defaultModel: "saved" } : { model: "b/saved" }));
  await writeFile(authPath, JSON.stringify({ b: { type: harness === "pi" ? "api_key" : "api", key: "fixture-key" } }));
  const observe = () => observeGenericNativeProfile({ homePath, harness, providerIds: ["a", "b"], env: {}, now });
  return { homePath, authPath, configPath, observe, cleanup: () => rm(homePath, { recursive: true, force: true }) };
}

describe("bounded native default/profile observations", () => {
  it.each(["pi", "opencode"] as const)("%s observes only the matching provider and never remote readiness", async (harness) => {
    const f = await fixture(harness);
    try {
      const result = await f.observe();
      expect(result.defaultModel).toBe("b:saved");
      expect(result.observations.a.state).toBe("absent");
      expect(result.observations.b).toEqual({ state: "present_unverified", checkedAt: now.toISOString(), staleAfter: new Date(now.getTime() + 5000).toISOString() });
      expect(JSON.stringify(result)).not.toContain("fixture-key"); expect(JSON.stringify(result)).not.toContain(f.homePath);
      await rm(f.authPath); expect((await f.observe()).observations.b.state).toBe("unknown");
    } finally { await f.cleanup(); }
  });
  it.each(["pi", "opencode"] as const)("%s does not invent a default from missing or malformed config", async (harness) => {
    const f = await fixture(harness);
    try { await writeFile(f.configPath, "{}"); expect((await f.observe()).defaultModel).toBeNull();
      await writeFile(f.configPath, "invalid"); expect((await f.observe()).defaultModel).toBeNull();
    } finally { await f.cleanup(); }
  });
  it.each(["pi", "opencode"] as const)("%s refuses symlinked, oversized or malformed credential metadata", async (harness) => {
    const f = await fixture(harness);
    try {
      await writeFile(f.authPath, "x".repeat(128 * 1024 + 1)); expect((await f.observe()).observations.b.state).toBe("unknown");
      await writeFile(f.authPath, "invalid"); expect((await f.observe()).observations.b.state).toBe("unknown");
      await rm(f.authPath); await symlink(f.configPath, f.authPath); expect((await f.observe()).observations.b.state).toBe("unknown");
    } finally { await f.cleanup(); }
  });
  it.each(["pi", "opencode"] as const)("%s refreshable OAuth remains locally configured, while unresolved credentials cannot assert local login", async (harness) => {
    const f = await fixture(harness);
    try {
      await writeFile(f.authPath, JSON.stringify({ b: { type: "oauth", access: "fixture", refresh: "fixture", expires: now.getTime() - 1 } }));
      expect((await f.observe()).observations.b.state).toBe("present_unverified");
      await writeFile(f.authPath, JSON.stringify({ b: { type: harness === "pi" ? "api_key" : "api", key: "!echo fixture" } }));
      expect((await f.observe()).observations.b.state).toBe("absent");
    } finally { await f.cleanup(); }
  });
  it("OpenCode does not borrow a lower-precedence JSON default when JSONC overrides exist", async () => {
    const f = await fixture("opencode");
    try { await writeFile(join(f.homePath, ".config/opencode/opencode.jsonc"), '{ "model": "a/other" }');
      expect((await f.observe()).defaultModel).toBeNull();
    } finally { await f.cleanup(); }
  });
  it("shares an unfinished timed-out metadata read and never borrows a changed source scope", async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<{ defaultModel: null; observations: {} }>(() => undefined));
    const observe = createGenericNativeProfileObserver(read);
    const input = { homePath: "/owner", harness: "pi" as const, providerIds: ["b"], env: {}, now };
    try {
      const first = observe(input); await vi.advanceTimersByTimeAsync(1001); expect(await first).toEqual({ defaultModel: null, observations: {} });
      const second = observe(input); await vi.advanceTimersByTimeAsync(1001); await second;
      expect(await observe({ ...input, providerIds: ["a"] })).toEqual({ defaultModel: null, observations: {} });
      expect(read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("OpenCode never borrows another owner's XDG credential directory", async () => {
    const f = await fixture("opencode");
    try { const result = await observeGenericNativeProfile({ homePath: f.homePath, harness: "opencode", providerIds: ["b"], env: { XDG_DATA_HOME: "/tmp", XDG_CONFIG_HOME: "/tmp" }, now });
      expect(result.defaultModel).toBeNull(); expect(result.observations.b.state).toBe("unknown");
    } finally { await f.cleanup(); }
  });
});

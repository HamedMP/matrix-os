import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createCodexNativeAccountMetadataReader, normalizeCodexNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/codex-native-account-metadata.js";
const now = new Date("2026-10-02T08:00:00Z");
const account = { account: { type: "chatgpt", email: "owner@example.test", planType: "plus", secret: "never-return" } };
const limits = { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1790931600 } } };
describe("native Codex account metadata", () => {
  it("allowlists identity and authoritative quota without secrets", () => {
    const value = normalizeCodexNativeAccountMetadata(account, limits, now);
    expect(value).toMatchObject({ accountLabel: "owner@example.test", usage: { kind: "subscription_allowance", usedBasisPoints: 2500, authority: "provider_allowance" } });
    expect(JSON.stringify(value)).not.toContain("never-return");
  });
  it.each([0, 100])("preserves real %i percent", usedPercent => {
    expect(normalizeCodexNativeAccountMetadata(account, { rateLimits: { primary: { ...limits.rateLimits.primary, usedPercent } } }, now)?.usage?.usedBasisPoints).toBe(usedPercent * 100);
  });
  it.each([null, -1, 101, "25", Number.NaN])("rejects invalid quota %s", usedPercent => {
    expect(normalizeCodexNativeAccountMetadata(account, { rateLimits: { primary: { ...limits.rateLimits.primary, usedPercent } } }, now)?.usage).toBeUndefined();
  });
  it("does not take unrelated product limits when a keyed map exists", () => {
    expect(normalizeCodexNativeAccountMetadata(account, { ...limits, rateLimitsByLimitId: { other: limits.rateLimits } }, now)?.usage).toBeUndefined();
  });
  it("API keys never inherit ChatGPT quota or identity", () => {
    expect(normalizeCodexNativeAccountMetadata({ account: { type: "apiKey", email: "wrong@example.test" } }, limits, now)).toMatchObject({ accountLabel: "API key", authMethod: "api_key" });
    expect(normalizeCodexNativeAccountMetadata({ account: { type: "apiKey" } }, limits, now)?.usage).toBeUndefined();
  });
  it("rejects unsafe identity instead of echoing arbitrary native strings", () => {
    expect(normalizeCodexNativeAccountMetadata({ account: { type: "chatgpt", email: "/private/secret" } }, limits, now)).toBeNull();
  });
  function fixture(changed = false, quotaFails = false, accountResult = account, notification?: "initial" | "during_quota" | "late_initial", retry?: { account: unknown; limits: unknown; finalAccount?: unknown }) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => child.emit("close")); return true; }) });
    const methods: unknown[] = [];
    child.stdin.on("data", chunk => {
      const request = JSON.parse(chunk.toString()); methods.push(request);
      if (!request.id) return;
      const result = request.id >= 5 && retry
        ? request.method === "account/rateLimits/read" ? retry.limits : request.id === 7 ? retry.finalAccount ?? retry.account : retry.account
        : request.id === 1 ? {} : request.method === "account/rateLimits/read" ? limits : changed && request.id === 4 ? { account: { type: "chatgpt", email: "other@example.test" } } : accountResult;
      queueMicrotask(() => {
        if (notification === "initial" && request.id === 2 || notification === "during_quota" && request.method === "account/rateLimits/read" || notification === "late_initial" && request.id === 3)
          child.stdout.write(JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } }) + "\n");
        child.stdout.write(JSON.stringify(request.id === 3 && quotaFails ? { id: 3, error: { message: "private-token" } } : { id: request.id, result }) + "\n");
        if (notification === "late_initial" && request.id === 3) child.stdout.write(JSON.stringify({ id: 4, result: accountResult }) + "\n");
      });
    });
    const spawnProcess = vi.fn(() => child as never);
    return { child, methods, spawnProcess };
  }
  it("uses only the supplied runtime and refreshToken false; exits child", async () => {
    const f = fixture();
    const reader = createCodexNativeAccountMetadataReader({ executable: "/runtime/bin/codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home", CODEX_HOME: "/runtime/codex", OPENAI_API_KEY: "operator-key-never-use" }, now: () => now, spawnProcess: f.spawnProcess });
    expect(await reader()).toMatchObject({ accountLabel: "owner@example.test" });
    expect(f.spawnProcess.mock.calls[0]).toMatchObject(["/runtime/bin/codex", ["app-server", "--stdio"], { env: { HOME: "/runtime/home", CODEX_HOME: "/runtime/codex" } }]);
    expect(f.spawnProcess.mock.calls[0]).not.toEqual(expect.arrayContaining([expect.objectContaining({ env: expect.objectContaining({ OPENAI_API_KEY: "operator-key-never-use" }) })]));
    expect(f.methods).toContainEqual({ id: 2, method: "account/read", params: { refreshToken: false } });
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("reads identity and quota after the real native initialization account notification", async () => {
    const f = fixture(false, false, account, "initial");
    const reader = createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess: f.spawnProcess });
    expect(await reader()).toMatchObject({ accountLabel: "owner@example.test", usage: { usedBasisPoints: 2500 } });
    expect(f.methods).toContainEqual({ id: 4, method: "account/read", params: { refreshToken: false } });
  });
  it("still discards quota when an account notification arrives after the identity baseline", async () => {
    const f = fixture(false, false, account, "during_quota");
    expect(await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess: f.spawnProcess })()).toBeNull();
  });
  it("restarts a bounded metadata sequence when the initial native notification arrives late", async () => {
    const f = fixture(false, false, account, "late_initial");
    const value = await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess: f.spawnProcess })();
    expect(value).toMatchObject({ accountLabel: "owner@example.test", usage: { usedBasisPoints: 2500 } });
    expect(f.methods).toContainEqual({ id: 5, method: "account/read", params: { refreshToken: false } });
    expect(f.methods).toContainEqual({ id: 6, method: "account/rateLimits/read", params: {} });
    expect(f.methods).toContainEqual({ id: 7, method: "account/read", params: { refreshToken: false } });
    expect(f.spawnProcess).toHaveBeenCalledOnce();
  });
  it("ignores stale prior-sequence identity and quota when retry observes another account", async () => {
    const freshAccount = { account: { type: "chatgpt", email: "fresh@example.test", id: "fresh-principal" } };
    const freshLimits = { rateLimits: { primary: { ...limits.rateLimits.primary, usedPercent: 73 } } };
    const f = fixture(false, false, account, "late_initial", { account: freshAccount, limits: freshLimits });
    const value = await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess: f.spawnProcess })();
    expect(value).toMatchObject({ accountLabel: "fresh@example.test", usage: { usedBasisPoints: 7300 } });
    expect(JSON.stringify(value)).not.toContain("owner@example.test");
    expect(JSON.stringify(value)).not.toContain("never-return");
  });
  it("rejects another principal change during the restarted quota sequence", async () => {
    const f = fixture(false, false, account, "late_initial", { account: { account: { type: "chatgpt", email: "fresh@example.test" } }, limits,
      finalAccount: { account: { type: "chatgpt", email: "third@example.test" } } });
    expect(await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess: f.spawnProcess })()).toBeNull();
  });
  it("never carries old subscription identity or quota into an API-key retry", async () => {
    const f = fixture(false, false, account, "late_initial", { account: { account: { type: "apiKey" } }, limits });
    const value = await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess: f.spawnProcess })();
    expect(value).toMatchObject({ accountLabel: "API key", authMethod: "api_key" });
    expect(value?.usage).toBeUndefined();
    expect(f.methods).not.toContainEqual(expect.objectContaining({ id: 6 }));
  });
  it("API-key metadata skips the subscription allowance request", async () => {
    const f = fixture(false, false, { account: { type: "apiKey" } } as never);
    const value = await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, spawnProcess: f.spawnProcess })();
    expect(value).toMatchObject({ authMethod: "api_key", accountLabel: "API key" });
    expect(f.methods).not.toContainEqual(expect.objectContaining({ method: "account/rateLimits/read" }));
  });
  it("keeps authoritative usage with an unknown reset rather than making it zero", () => {
    expect(normalizeCodexNativeAccountMetadata(account, { rateLimits: { primary: { ...limits.rateLimits.primary, resetsAt: null } } }, now)?.usage).toMatchObject({ usedBasisPoints: 2500, resetsAt: null });
  });
  it("drops results when the native principal changes while quota is read", async () => {
    const f = fixture(true);
    expect(await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, spawnProcess: f.spawnProcess })()).toBeNull();
  });
  it("preserves identity when allowance method is unsupported", async () => {
    const f = fixture(false, true);
    expect(await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, spawnProcess: f.spawnProcess })()).toMatchObject({ accountLabel: "owner@example.test" });
  });
});

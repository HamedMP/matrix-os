import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
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
    expect(value).toMatchObject({ accountLabel: "owner@example.test", connectionDetails: { email: "owner@example.test", planName: "ChatGPT Plus" }, usage: { kind: "subscription_allowance", usedBasisPoints: 2500, authority: "provider_allowance" } });
    expect(JSON.stringify(value)).not.toContain("never-return");
  });
  it("keeps identity when allowance is unavailable and does not echo an unknown plan", () => {
    expect(normalizeCodexNativeAccountMetadata(account, undefined, now)).toMatchObject({ connectionDetails: { email: "owner@example.test", planName: "ChatGPT Plus" } });
    const unknown = normalizeCodexNativeAccountMetadata({ account: { type: "chatgpt", email: "owner@example.test", planType: "private-token-secret" } }, undefined, now);
    expect(unknown).toMatchObject({ connectionDetails: { email: "owner@example.test" } });
    expect(JSON.stringify(unknown)).not.toContain("private-token-secret");
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
  function fixture(changed = false, quotaFails = false, accountResult: unknown = account, notification?: "initial" | "during_quota" | "late_initial", retry?: { account: unknown; limits: unknown; finalAccount?: unknown }, omitId?: number, backend?: string) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => child.emit("close")); return true; }) });
    const methods: unknown[] = [];
    child.stdin.on("data", chunk => {
      const request = JSON.parse(chunk.toString()); methods.push(request);
      if (!request.id || request.id === omitId) return;
      const result = request.method === "config/read" ? { config: { cli_auth_credentials_store: backend } } : request.id >= 5 && retry
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
  it("projects the official missing-id reply using the actual bounded file proof", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-reader-file-"));
    try {
      await mkdir(join(home, ".codex"), { mode: 0o700 });
      await writeFile(join(home, ".codex/auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "private-fixture-access", refresh_token: "private-fixture-refresh" } }), { mode: 0o600 });
      const first = fixture(false, false, account, undefined, undefined, undefined, "file");
      const current = fixture(false, false, account, undefined, undefined, undefined, "file");
      const value = await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: home, environment: { HOME: home }, now: () => now,
        spawnProcess: vi.fn().mockImplementationOnce(first.spawnProcess).mockImplementationOnce(current.spawnProcess) })();
      expect(await verifyNativeAccountMetadata(value)).toBe(value);
      expect(value?.connectionDetails?.planName).toBe("ChatGPT Plus");
      expect(value?.usage?.usedBasisPoints).toBe(2500);
      expect(first.methods).toContainEqual({ id: 8, method: "config/read", params: { includeLayers: false, cwd: home } });
      expect(JSON.stringify(value)).not.toMatch(/private-fixture|credentialProof|digest/);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("rejects a same-presentation credential switch between spawn and effective config observation", async () => {
    let proof = "spawn-principal";
    const f = fixture(false, false, account, undefined, undefined, undefined, "file");
    const spawnProcess = vi.fn(() => { proof = "replacement-principal"; return f.spawnProcess(); });
    const value = await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess,
      readCredentialFileProof: async () => proof })();
    expect(value).toBeNull();
  });
  it("binds the official missing-id ChatGPT reply to a file-backed private credential proof", async () => {
    const first = fixture(false, false, account, undefined, undefined, undefined, "file");
    const current = fixture(false, false, account, undefined, undefined, undefined, "file");
    const readCredentialFileProof = vi.fn(async () => "private-proof-credential");
    const spawnProcess = vi.fn().mockImplementationOnce(first.spawnProcess).mockImplementationOnce(current.spawnProcess);
    const reader = createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home", CODEX_HOME: "/selected/profile" }, now: () => now, spawnProcess, readCredentialFileProof });
    const value = await reader();
    expect(await verifyNativeAccountMetadata(value)).toBe(value);
    expect(value?.usage?.usedBasisPoints).toBe(2500);
    expect(readCredentialFileProof).toHaveBeenCalledTimes(6);
    expect(current.methods).not.toContainEqual(expect.objectContaining({ method: "account/rateLimits/read" }));
    expect(JSON.stringify(value)).not.toContain("private-proof");
  });
  it("rejects same-presentation credentials switched after the full metadata read", async () => {
    let proof = "old-private-credential";
    const first = fixture(false, false, account, undefined, undefined, undefined, "file");
    const current = fixture(false, false, account, undefined, undefined, undefined, "file");
    const reader = createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now,
      spawnProcess: vi.fn().mockImplementationOnce(first.spawnProcess).mockImplementationOnce(current.spawnProcess), readCredentialFileProof: async () => proof });
    const value = await reader();
    expect(value?.usage).toBeDefined(); proof = "replacement-private-credential";
    expect(await verifyNativeAccountMetadata(value)).toBeNull();
  });
  it("drops a credential switch during quota even when account labels remain identical", async () => {
    let calls = 0;
    const f = fixture(false, false, account, undefined, undefined, undefined, "file");
    const reader = createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess: f.spawnProcess,
      readCredentialFileProof: async () => ++calls <= 2 ? "old" : "new" });
    expect(await reader()).toBeNull();
  });
  it.each(["keyring", "auto", undefined])("never borrows a stale file when effective backend is %s", async backend => {
    const f = fixture(false, false, account, undefined, undefined, undefined, backend);
    const readCredentialFileProof = vi.fn(async () => "stale-file-proof");
    const value = await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess: f.spawnProcess, readCredentialFileProof })();
    expect(await verifyNativeAccountMetadata(value)).toBeNull();
    expect(readCredentialFileProof).toHaveBeenCalledTimes(1);
  });
  it("verifies the exact selected native principal after the metadata helper exits, without quota or token refresh", async () => {
    const first = fixture(false, false, { account: { ...account.account, id: "private-old-id" } });
    const current = fixture(false, false, { account: { ...account.account, id: "private-new-id" } });
    const spawnProcess = vi.fn().mockImplementationOnce(first.spawnProcess).mockImplementationOnce(current.spawnProcess);
    const reader = createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home", CODEX_HOME: "/selected/profile" }, now: () => now, spawnProcess });
    const value = await reader();
    expect(value?.usage).toBeDefined();
    expect(await verifyNativeAccountMetadata(value)).toBeNull();
    expect(current.methods).not.toContainEqual(expect.objectContaining({ method: "account/rateLimits/read" }));
    expect(spawnProcess.mock.calls[1]?.[2]?.env.CODEX_HOME).toBe("/selected/profile");
    expect(JSON.stringify(value)).not.toContain("private-old-id");
  });
  it("coalesces current principal reads without transferring proof across observations", async () => {
    let clock = now;
    const first = fixture(false, false, { account: { ...account.account, id: "old-private-id" } });
    const second = fixture(false, false, { account: { ...account.account, id: "new-private-id" } });
    const current = fixture(false, false, { account: { ...account.account, id: "old-private-id" } });
    const spawnProcess = vi.fn().mockImplementationOnce(first.spawnProcess).mockImplementationOnce(second.spawnProcess).mockImplementationOnce(current.spawnProcess);
    const reader = createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => clock, spawnProcess });
    const old = await reader(); clock = new Date(now.getTime() + 6000); const newer = await reader();
    const [oldVerified, newVerified] = await Promise.all([verifyNativeAccountMetadata(old), verifyNativeAccountMetadata(newer)]);
    expect(oldVerified).toBe(old);
    expect(newVerified).toBeNull();
    expect(spawnProcess).toHaveBeenCalledTimes(3);
    expect(current.methods).not.toContainEqual(expect.objectContaining({ method: "account/rateLimits/read" }));
    expect(JSON.stringify([old, newer])).not.toContain("private-id");
  });
  it("fails closed when native account/read lacks exact principal proof", async () => {
    const f = fixture();
    const reader = createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess: f.spawnProcess });
    expect(await verifyNativeAccountMetadata(await reader())).toBeNull();
    expect(f.spawnProcess).toHaveBeenCalledTimes(1);
  });
  it("revalidates API-key class without borrowing ChatGPT identity or quota", async () => {
    const first = fixture(false, false, { account: { type: "apiKey" } });
    const current = fixture(false, false, { account: { type: "apiKey" } });
    const changed = fixture(false, false, { account: { ...account.account, id: "private-id" } });
    const spawnProcess = vi.fn().mockImplementationOnce(first.spawnProcess).mockImplementationOnce(current.spawnProcess).mockImplementationOnce(changed.spawnProcess);
    const reader = createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess });
    const value = await reader();
    expect(await verifyNativeAccountMetadata(value)).toEqual({ accountLabel: "API key", authMethod: "api_key", checkedAt: now.toISOString(), staleAfter: new Date(now.getTime() + 30000).toISOString() });
    expect(await verifyNativeAccountMetadata(value)).toBeNull();
    expect([...first.methods, ...current.methods, ...changed.methods]).not.toContainEqual(expect.objectContaining({ method: "account/rateLimits/read" }));
  });
  it("keeps a proved ChatGPT principal and allowance without exposing its native ID", async () => {
    const first = fixture(false, false, { account: { ...account.account, id: "private-current-id" } });
    const current = fixture(false, false, { account: { ...account.account, id: "private-current-id" } });
    const spawnProcess = vi.fn().mockImplementationOnce(first.spawnProcess).mockImplementationOnce(current.spawnProcess);
    const value = await createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess })();
    expect(await verifyNativeAccountMetadata(value)).toBe(value);
    expect(value?.usage?.usedBasisPoints).toBe(2500);
    expect(JSON.stringify(value)).not.toContain("private-current-id");
  });
  it.each([3, 4])("drops identity when sequence times out before final equality (id %i)", async omitId => {
    const f = fixture(false, false, account, undefined, undefined, omitId);
    const reader = createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, timeoutMs: 10, now: () => now, spawnProcess: f.spawnProcess });
    expect(await reader()).toBeNull();
  });
  it("returns unavailable during cooldown instead of delaying another read", async () => {
    const f = fixture();
    const reader = createCodexNativeAccountMetadataReader({ executable: "codex", cwd: "/runtime/home", environment: { HOME: "/runtime/home" }, now: () => now, spawnProcess: f.spawnProcess });
    await reader();
    expect(await Promise.race([reader(), new Promise(resolve => setTimeout(() => resolve("delayed"), 20))])).toBeNull();
    expect(f.spawnProcess).toHaveBeenCalledTimes(1);
  });
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

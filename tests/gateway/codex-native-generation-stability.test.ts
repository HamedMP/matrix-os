import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { createCodexNativeAccountMetadataReader } from "../../packages/gateway/src/ai-providers/codex-native-account-metadata";
import { nativeAccountLegacyPrincipalFingerprint, nativeAccountPrincipalFingerprint } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding";

// ENG-523: Codex rewrites auth.json whenever it refreshes its ChatGPT tokens.
// Durable consent must follow the signed-in account, not the rotating token bytes,
// otherwise a valid login shows usage in Settings while Chat demands sign-in.
// Only app-server I/O, the clock and private file evidence are synthetic.
function fixture() {
  const epoch = Date.parse("2026-11-21T10:00:00Z"); let elapsed = 0;
  let account: Record<string, string> = { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" };
  let evidence: { proof: string; identity: string | null } = { proof: "bytes-generation-1", identity: "account-identity-a" };
  const spawnProcess = vi.fn(() => {
    const observed = account;
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => { queueMicrotask(() => child.emit("close", 0)); return true; }) });
    child.stdin.on("data", chunk => {
      const req = JSON.parse(chunk.toString()); if (!req.id) return;
      const result = req.method === "initialize" ? {} : req.method === "config/read" ? { config: { cli_auth_credentials_store: "file" } }
        : req.method === "account/rateLimits/read" ? { rateLimits: null, rateLimitsByLimitId: null } : { account: observed, requiresOpenaiAuth: true };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: req.id, result }) + "\n"));
    });
    return child as never;
  });
  const reader = createCodexNativeAccountMetadataReader({ executable: "/synthetic/codex", cwd: "/synthetic/home", environment: { HOME: "/synthetic/home" },
    now: () => new Date(epoch + elapsed), spawnProcess, readCredentialFileEvidence: async () => evidence, timeoutMs: 20, terminateGraceMs: 1 });
  return {
    reader,
    next: () => { elapsed += 10_000; },
    refreshTokens: () => { evidence = { ...evidence, proof: `${evidence.proof}-refreshed` }; },
    switchAccount: () => { evidence = { proof: "bytes-other-account", identity: "account-identity-b" }; },
    changePlan: () => { account = { ...account, planType: "pro" }; },
    dropIdentity: () => { evidence = { ...evidence, identity: null }; },
  };
}

it("keeps the durable Codex generation across token refreshes of the same account", async () => {
  const f = fixture();
  const before = await f.reader();
  expect(before).toMatchObject({ authMethod: "terminal" });
  f.refreshTokens(); f.next();
  const after = await f.reader();
  expect(after).toMatchObject({ authMethod: "terminal" });
  expect(nativeAccountPrincipalFingerprint(after!)).toMatch(/^[a-f0-9]{64}$/);
  expect(nativeAccountPrincipalFingerprint(after!)).toBe(nativeAccountPrincipalFingerprint(before!));
});

it("keeps the durable Codex generation when only the ChatGPT plan changes", async () => {
  const f = fixture();
  const before = await f.reader();
  f.changePlan(); f.next();
  const after = await f.reader();
  expect(nativeAccountPrincipalFingerprint(after!)).toBe(nativeAccountPrincipalFingerprint(before!));
});

it("changes the durable Codex generation for a different signed-in account", async () => {
  const f = fixture();
  const before = await f.reader();
  f.switchAccount(); f.next();
  const after = await f.reader();
  expect(after).not.toBeNull();
  expect(nativeAccountPrincipalFingerprint(after!)).not.toBe(nativeAccountPrincipalFingerprint(before!));
});

it("exposes the legacy token-bound generation only for upgrading saved consent", async () => {
  const f = fixture();
  const current = await f.reader();
  const legacy = nativeAccountLegacyPrincipalFingerprint(current!);
  expect(legacy).toMatch(/^[a-f0-9]{64}$/);
  expect(legacy).not.toBe(nativeAccountPrincipalFingerprint(current!));
});

it("falls back to the exact credential generation when the file carries no stable account identity", async () => {
  const f = fixture(); f.dropIdentity();
  const before = await f.reader();
  expect(nativeAccountLegacyPrincipalFingerprint(before!)).toBeNull();
  f.refreshTokens(); f.next();
  const after = await f.reader();
  expect(nativeAccountPrincipalFingerprint(after!)).not.toBe(nativeAccountPrincipalFingerprint(before!));
});

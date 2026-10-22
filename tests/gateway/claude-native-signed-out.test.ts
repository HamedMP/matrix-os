import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClaudeNativeAccountMetadataReader } from "../../packages/gateway/src/ai-providers/claude-native-account-metadata.js";
import { verifyClaudeNativeSignedOut } from "../../packages/gateway/src/ai-providers/claude-native-signed-out.js";
import { verifyNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";

const homes: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "claude-private-absence-")); homes.push(home);
  const raw = { loggedIn: false, authMethod: "none", apiProvider: "firstParty", configDirectory: join(home, ".claude") };
  const error = (fields: Record<string, unknown> = {}) => Object.assign(new Error("synthetic-status-exit"), { code: 1, stdout: JSON.stringify(raw), stderr: "", ...fields });
  const runCommand = vi.fn(async (): Promise<{ stdout: string }> => { throw error(); });
  const assertProfileAvailable = vi.fn(async () => {});
  let time = new Date();
  const read = createClaudeNativeAccountMetadataReader({ executable: "claude", cwd: home, environment: { HOME: home }, runCommand, assertProfileAvailable, now: () => time });
  return { home, raw, error, runCommand, assertProfileAvailable, read, advance: () => { time = new Date(+time + 30_000); } };
}

it("accepts the real exit-1 signed-out contract but never projects authenticated metadata", async () => {
  const f = await fixture();
  expect(await f.read()).toBeNull();
  const proof = await f.read.readSignedOut!();
  expect(proof).not.toBeNull();
  expect(await verifyClaudeNativeSignedOut(proof, f.home)).toBe(proof);
  expect(await verifyClaudeNativeSignedOut(proof, join(f.home, "other"))).toBeNull();
  expect(await verifyClaudeNativeSignedOut(proof && { ...proof }, f.home)).toBeNull();
  f.advance(); expect(await verifyClaudeNativeSignedOut(proof, f.home)).toBeNull();
});

it.each(["code", "signal", "killed", "stderr", "malformed", "oversized", "config", "method", "provider", "authenticated-error", "missing-fields", "unavailable"] as const)("rejects %s as signed-out authority", async mode => {
  const f = await fixture();
  const patches: Record<typeof mode, Record<string, unknown>> = {
    code: { code: 2 }, signal: { signal: "SIGKILL" }, killed: { killed: true }, stderr: { stderr: "synthetic-error" },
    malformed: { stdout: "not-json" }, oversized: { stdout: " ".repeat(8193) },
    config: { stdout: JSON.stringify({ ...f.raw, configDirectory: "/other/.claude" }) },
    method: { stdout: JSON.stringify({ ...f.raw, authMethod: "claude.ai" }) },
    provider: { stdout: JSON.stringify({ ...f.raw, apiProvider: "thirdParty" }) },
    "authenticated-error": { stdout: JSON.stringify({ ...f.raw, loggedIn: true, authMethod: "claude.ai", email: "synthetic@example.invalid" }) },
    "missing-fields": { stdout: JSON.stringify({ loggedIn: false }) }, unavailable: {},
  };
  f.runCommand.mockRejectedValue(mode === "unavailable" ? new Error("unavailable") : f.error(patches[mode]));
  expect(await f.read.readSignedOut!()).toBeNull();
  expect(await f.read()).toBeNull();
});

it("rejects a login or writer appearing while signed-out proof is verified", async () => {
  const f = await fixture(); const proof = await f.read.readSignedOut!();
  f.runCommand.mockResolvedValue({ stdout: JSON.stringify({ ...f.raw, loggedIn: true, authMethod: "claude.ai", email: "synthetic@example.invalid" }) });
  expect(await verifyClaudeNativeSignedOut(proof, f.home)).toBeNull();
  f.runCommand.mockRejectedValue(f.error());
  f.assertProfileAvailable.mockRejectedValue(new Error("writer-busy"));
  expect(await f.read.readSignedOut!()).toBeNull();
});

it("parses signed-out JSON from a real exit-1 subprocess with exact HOME binding", async () => {
  const f = await fixture(); const executable = join(f.home, "claude-status");
  await writeFile(executable, `#!/bin/sh\n[ "$1 $2 $3" = "auth status --json" ] || exit 2\n[ "$HOME" = '${f.home}' ] || exit 3\nprintf '%s' '${JSON.stringify(f.raw)}'\nexit 1\n`, { mode: 0o700 });
  const read = createClaudeNativeAccountMetadataReader({ executable, cwd: f.home, environment: { HOME: f.home } });
  const proof = await read.readSignedOut!();
  expect(await verifyClaudeNativeSignedOut(proof, f.home)).toBe(proof);
  expect(proof).not.toBeNull();
});

it("invalidates identity and allowance proof when native lifecycle changes the profile", async () => {
  const f = await fixture();
  f.runCommand.mockResolvedValue({ stdout: JSON.stringify({ ...f.raw, loggedIn: true, authMethod: "claude.ai", email: "synthetic@example.invalid" }) });
  const before = await f.read(); expect(before).not.toBeNull();
  f.read.invalidate!();
  expect(await verifyNativeAccountMetadata(before)).toBeNull();
  const after = await f.read(); expect(await verifyNativeAccountMetadata(after)).toBe(after);
});


it("drops the default quota cache and old identity proof even if credential bytes are unchanged", async () => {
  const f = await fixture();
  await mkdir(join(f.home, ".claude"), { mode: 0o700 });
  await writeFile(join(f.home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-private-token", expiresAt: Date.now() + 3600000, scopes: ["user:profile"] } }), { mode: 0o600 });
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3600000).toISOString() } })));
  vi.stubGlobal("fetch", fetcher);
  f.runCommand.mockResolvedValue({ stdout: JSON.stringify({ ...f.raw, loggedIn: true, authMethod: "claude.ai", email: "synthetic@example.invalid" }) });
  const before = await f.read(true); expect(before?.usage?.usedBasisPoints).toBe(4200);
  await f.read(true); expect(fetcher).toHaveBeenCalledOnce();
  f.read.invalidate!();
  expect(await verifyNativeAccountMetadata(before)).toBeNull();
  const after = await f.read(true); expect(after?.usage?.usedBasisPoints).toBe(4200);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

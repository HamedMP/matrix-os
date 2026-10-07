import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMatrixAnthropicSourceStore, readMatrixAnthropicCredentialGeneration } from "../../packages/gateway/src/ai-providers/matrix-anthropic-source.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { readOwnerAnthropicKey, revokeOwnerAnthropicKey } from "../../packages/gateway/src/ai-providers/owner-anthropic-key.js";
import { storeApiKey } from "../../packages/gateway/src/onboarding/api-key.js";
import { createNativeProviderWriterLease } from "../../packages/gateway/src/ai-providers/native-provider-writer-lease.js";
import { CodexKeyRollbackFailedError } from "../../packages/gateway/src/ai-providers/codex-key-transaction.js";
import * as persistence from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";

const ownedHomes: string[] = []; // bounded to this suite's fixture count and drained after each test
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(ownedHomes.splice(0).map(home => rm(join(dirname(home), ".matrix-private", basename(home)), { recursive: true, force: true })));
});

function storeFor(homePath: string) {
  if (!ownedHomes.includes(homePath)) ownedHomes.push(homePath);
  const profileGuard = createNativeProviderProfileGuard({ homePath, registry: {
    async get() { throw Object.assign(new Error("missing synthetic session"), { code: "session_not_found" }); },
    async observeAgentLiveness() { return "stopped"; },
  } });
  return createMatrixAnthropicSourceStore({ homePath, profileGuard });
}
const firstRequest = { expectedRevision: 0, expectedCredentialGeneration: null, idempotencyKey: "connect-1", apiKey: "sk-ant-synthetic-owner" };
it("publishes one explicitly enabled source with its canonical generation under shared writer admission", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-source-"));
  try {
    const store = storeFor(home);
    expect(await store.read()).toEqual({ version: 1, revision: 0, enabled: false, credentialGeneration: null });
    const result = await store.commitConnection(firstRequest), key = await readOwnerAnthropicKey(home);
    expect(result).toEqual({ state: { version: 1, revision: 1, enabled: true, credentialGeneration: key.credentialGeneration }, appliedRevision: 1, replayed: false });
    expect(result.state.credentialGeneration).toMatch(/^[a-f0-9-]{36}$/);
    expect(await store.read()).toEqual(result.state);
    expect(JSON.stringify(result)).not.toContain(firstRequest.apiKey);
    const privateDocument = await readFile(join(home, "system/ai-providers/matrix-anthropic-source.json"), "utf8");
    expect(privateDocument).not.toContain(firstRequest.apiKey);
    await expect(readFile(join(home, "system/ai-providers/settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("bounds durable retry history and cannot resurrect an evicted stale Connect", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-receipts-"));
  try {
    const store = storeFor(home); let state = (await store.commitConnection(firstRequest)).state;
    for (let index = 0; index < 65; index++) state = (await store.disconnect({ expectedRevision: state.revision,
      expectedCredentialGeneration: state.credentialGeneration, idempotencyKey: `disconnect-${index}` })).state;
    const document = JSON.parse(await readFile(join(home, "system/ai-providers/matrix-anthropic-source.json"), "utf8"));
    expect(document.receipts).toHaveLength(64);
    await expect(store.commitConnection(firstRequest)).rejects.toMatchObject({ code: "conflict" });
    expect(await store.read()).toEqual(state); expect(state.enabled).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("requires actual durable shared writer admission before publishing a connection", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-writer-"));
  let release: (() => Promise<void>) | undefined;
  try {
    const store = storeFor(home);
    release = await createNativeProviderWriterLease(home).acquire("claude");
    await expect(store.commitConnection(firstRequest)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(await store.read()).toMatchObject({ enabled: false, revision: 0 });
    await release(); release = undefined;
    expect((await store.commitConnection(firstRequest)).state.enabled).toBe(true);
  } finally { await release?.(); await rm(home, { recursive: true, force: true }); }
});
it("retains exact recovery bytes and durable writer fencing when key rollback is uncertain", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-uncertain-"));
  try {
    const store = storeFor(home), connected = await store.commitConnection(firstRequest);
    const directory = join(home, "system/ai-providers"), keyPath = join(directory, "anthropic-key.json");
    const sourcePath = join(directory, "matrix-anthropic-source.json"), priorKey = await readFile(keyPath), priorSource = await readFile(sourcePath);
    const write = persistence.writeProviderJsonAtomic;
    vi.spyOn(persistence, "writeProviderJsonAtomic").mockImplementation(async (path, value) => {
      if (path === sourcePath) { await unlink(keyPath); throw new Error("synthetic metadata failure after key custody changed"); }
      return write(path, value);
    });
    await expect(store.commitConnection({ ...firstRequest, apiKey: "sk-ant-replacement", expectedRevision: 1,
      expectedCredentialGeneration: connected.state.credentialGeneration, idempotencyKey: "uncertain-replacement" })).rejects.toBeInstanceOf(CodexKeyRollbackFailedError);
    vi.restoreAllMocks();
    expect(await readFile(sourcePath)).toEqual(priorSource);
    expect(await readFile(join(directory, ".matrix-anthropic-key-staging/previous-auth"))).toEqual(priorKey);
    await expect(storeFor(home).commitConnection(firstRequest)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("replays exact receipts against current state without re-enabling or replacing shared credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-retry-"));
  try {
    const store = storeFor(home), connected = await store.commitConnection(firstRequest);
    const disconnect = { expectedRevision: 1, expectedCredentialGeneration: connected.state.credentialGeneration, idempotencyKey: "disconnect-1" };
    const disabled = await store.disconnect(disconnect), keyBefore = await readOwnerAnthropicKey(home);
    expect(disabled.state).toMatchObject({ revision: 2, enabled: false });
    expect(await storeFor(home).commitConnection(firstRequest)).toEqual({ state: disabled.state, appliedRevision: 1, replayed: true });
    expect(await storeFor(home).disconnect(disconnect)).toEqual({ state: disabled.state, appliedRevision: 2, replayed: true });
    expect(await readOwnerAnthropicKey(home)).toEqual(keyBefore);
    await expect(store.commitConnection({ ...firstRequest, apiKey: "sk-ant-different" })).rejects.toMatchObject({ code: "conflict" });
    await expect(store.commitConnection({ ...firstRequest, idempotencyKey: "stale-new-request" })).rejects.toMatchObject({ code: "conflict" });
    expect(await store.read()).toEqual(disabled.state);
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("rejects a native key replacement during verification despite unchanged Matrix source revision", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-stale-key-"));
  try {
    const store = storeFor(home), connected = await store.commitConnection(firstRequest);
    const captured = { ...firstRequest, expectedRevision: 1, expectedCredentialGeneration: connected.state.credentialGeneration, idempotencyKey: "replacement-after-probe" };
    await storeApiKey(home, "sk-ant-native-replacement");
    const native = await readOwnerAnthropicKey(home);
    expect(native.credentialGeneration).not.toBe(connected.state.credentialGeneration);
    await expect(store.commitConnection(captured)).rejects.toMatchObject({ code: "conflict" });
    await expect(store.disconnect({ ...captured, apiKey: undefined })).rejects.toMatchObject({ code: "rejected" });
    await expect(store.disconnect({ expectedRevision: 1, expectedCredentialGeneration: captured.expectedCredentialGeneration, idempotencyKey: "stale-disconnect" })).rejects.toMatchObject({ code: "conflict" });
    expect(await readOwnerAnthropicKey(home)).toEqual(native); expect(await store.read()).toEqual(connected.state);
    const accepted = await store.commitConnection({ ...captured, expectedCredentialGeneration: native.credentialGeneration! });
    expect(accepted.state).toMatchObject({ revision: 2, enabled: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("preserves prior key/generation and source bytes if atomic source publication fails, then permits safe retry", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-rollback-"));
  try {
    const store = storeFor(home), connected = await store.commitConnection(firstRequest);
    const directory = join(home, "system/ai-providers"), path = join(directory, "matrix-anthropic-source.json");
    const previousKey = await readFile(join(directory, "anthropic-key.json")), previousSource = await readFile(path);
    const temporary = join(directory, ".matrix-anthropic-source.json.tmp");
    await symlink(path, temporary);
    const request = { ...firstRequest, apiKey: "sk-ant-replacement", expectedRevision: 1,
      expectedCredentialGeneration: connected.state.credentialGeneration, idempotencyKey: "replacement-2" };
    await expect(store.commitConnection(request)).rejects.toThrow();
    expect(await readFile(join(directory, "anthropic-key.json"))).toEqual(previousKey); expect(await readFile(path)).toEqual(previousSource);
    await rm(temporary);
    expect((await store.commitConnection(request)).state.revision).toBe(2);
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("never mistakes unsafe credentials or source custody for empty state or silently qualifies legacy keys", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-legacy-"));
  try {
    const directory = join(home, "system/ai-providers"), keyPath = join(directory, "anthropic-key.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(keyPath, JSON.stringify({ version: 1, apiKey: "sk-ant-legacy" }), { mode: 0o600 });
    const store = storeFor(home);
    expect(await store.read()).toMatchObject({ enabled: false, credentialGeneration: null });
    await chmod(keyPath, 0o644);
    await expect(store.commitConnection(firstRequest)).rejects.toMatchObject({ code: "unavailable" });
    await chmod(keyPath, 0o600);
    expect((await store.commitConnection(firstRequest)).state).toMatchObject({ enabled: true, revision: 1 });
    const sourcePath = join(directory, "matrix-anthropic-source.json"); await chmod(sourcePath, 0o644);
    await expect(store.read()).rejects.toMatchObject({ code: "unavailable" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("preserves revoked tombstone generation for CAS without treating it as authentication", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-tombstone-"));
  try {
    const store = storeFor(home); await store.commitConnection(firstRequest);
    await revokeOwnerAnthropicKey(home);
    const revoked = await readOwnerAnthropicKey(home);
    expect(revoked.state).toBe("setup_required"); expect(revoked.key).toBeUndefined();
    expect(await readMatrixAnthropicCredentialGeneration(home)).toBe(revoked.credentialGeneration);
    await expect(store.commitConnection({ ...firstRequest, expectedRevision: 1, idempotencyKey: "after-revoke" })).rejects.toMatchObject({ code: "conflict" });
    expect((await store.commitConnection({ ...firstRequest, expectedRevision: 1,
      expectedCredentialGeneration: revoked.credentialGeneration!, idempotencyKey: "after-revoke-current" })).state.enabled).toBe(true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("retains writer fencing when a disconnect publisher reports failure after committing new state", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-anthropic-disconnect-uncertain-"));
  try {
    const store = storeFor(home), connected = await store.commitConnection(firstRequest);
    const sourcePath = join(home, "system/ai-providers/matrix-anthropic-source.json"), write = persistence.writeProviderJsonAtomic;
    vi.spyOn(persistence, "writeProviderJsonAtomic").mockImplementation(async (path, value) => {
      await write(path, value);
      if (path === sourcePath) throw new Error("synthetic failure after publication");
    });
    await expect(store.disconnect({ expectedRevision: 1, expectedCredentialGeneration: connected.state.credentialGeneration,
      idempotencyKey: "disconnect-uncertain" })).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await store.read()).toMatchObject({ enabled: false, revision: 2 });
    await expect(storeFor(home).commitConnection(firstRequest)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

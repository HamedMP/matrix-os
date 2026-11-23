import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import Ajv from "codex-fixture-ajv";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
// Keep the reader, its cooldown and private proof, admission, and durable
// registration real. Only the local Codex RPC process is deterministic.
vi.mock("../../packages/gateway/src/ai-providers/codex-native-account-metadata.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/ai-providers/codex-native-account-metadata.js")>();
  return { ...actual, createCodexNativeAccountMetadataReader: (input: Parameters<typeof actual.createCodexNativeAccountMetadataReader>[0]) =>
    actual.createCodexNativeAccountMetadataReader({ ...input, timeoutMs: 50, spawnProcess: transport.spawn }) };
});
import { createNativeCodexRuntime } from "../../packages/gateway/src/server/native-codex-runtime.js";
import { codexCatalogObservation, markCodexCatalogObservation } from "../../packages/gateway/src/ai-providers/codex-native-observation.js";
import type { ProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

const protocol = JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/codex-0171/app-server-schema-0171.json.gz", import.meta.url))).toString("utf8"));
const ajv = new Ajv({ schemaId: "auto", unknownFormats: "ignore", logger: false });
const clientRequest = ajv.compile({ $ref: "#/definitions/ClientRequest", definitions: protocol.definitions });
const clientNotification = ajv.compile({ $ref: "#/definitions/ClientNotification", definitions: protocol.definitions });

const homes: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function fixture(stallFirst = true) {
  const homePath = await mkdtemp(join(tmpdir(), "codex-identity-recovery-")); homes.push(homePath);
  let principal: { type: "chatgpt"; email: string; id: string } | null = { type: "chatgpt", email: "owner@example.test", id: "synthetic-native-owner" };
  const generation = createHash("sha256").update(JSON.stringify({ principal })).digest("hex");
  const directory = join(homePath, "system/ai-providers");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "settings.json"), JSON.stringify({
    schemaVersion: 1, revision: 1, harnesses: [{ id: "codex", driverId: "codex", harness: "codex", displayName: "Codex", accentColor: null,
      enabled: true, selectedAccountId: "owner_codex", accessSourceId: "owner_openai_profile", nativeAccountGeneration: generation,
      nativeAccountConsentRevision: 1, route: { kind: "fixed", providerId: "openai", modelId: "openai/gpt-5.6" } }],
    accountProfiles: [], gatewayPolicy: null, receipts: [],
  }));
  const methods: string[][] = [];
  let stallNext = stallFirst;
  let accountReads = 0, changeAfter = Infinity;
  transport.spawn.mockImplementation(() => {
    const stalled = stallNext; stallNext = false;
    const requests: string[] = []; methods.push(requests);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: () => { queueMicrotask(() => child.emit("close")); return true; } });
    child.stdin.on("data", chunk => {
      const request = JSON.parse(chunk.toString());
      const isRequest = Object.hasOwn(request, "id");
      const validate = isRequest ? clientRequest : clientNotification;
      expect(validate(request), ajv.errorsText(validate.errors)).toBe(true);
      requests.push(request.method);
      let result: unknown;
      switch (request.method) {
        case "initialized": return;
        case "initialize": result = {}; break;
        case "config/read": result = { config: { cli_auth_credentials_store: "keyring" } }; break;
        case "account/rateLimits/read": result = { rateLimits: null }; break;
        case "account/read":
          if (stalled) return;
          if (++accountReads > changeAfter) principal = { type: "chatgpt", email: "other@example.test", id: "synthetic-other-owner" };
          result = { account: principal }; break;
        default: throw new Error("Unsupported Codex fixture method");
      }
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
    });
    return child;
  });
  const snapshot = { revision: 1, access: { mode: "writable" },
    accessSources: [{ id: "owner_openai_profile", providerId: "openai", accountId: "owner_codex", kind: "provider_account", fundingKind: "owner_account" }],
    accounts: [{ id: "owner_codex", providerId: "openai", accessSourceId: "owner_openai_profile", authMethod: "terminal", authState: "authenticated" }],
  } as unknown as ProviderSettingsSnapshot;
  const getSnapshot = vi.fn(async () => snapshot);
  let settings: Pick<ProviderSettingsStore, "getSnapshot"> = { getSnapshot };
  const runtime = createNativeCodexRuntime({ homePath, executable: "/fixture/codex", ownerIds: ["owner"],
    environment: () => ({ HOME: homePath, CODEX_HOME: join(homePath, ".codex") }),
    profileGuard: { assertReadable: async () => undefined }, getSettings: () => settings, getRuntime: () => undefined,
  });
  const config: ProviderSettingsConfiguration = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  const unavailable = (state: "unavailable" | "signed_out" | "changed" = "unavailable") => markCodexCatalogObservation({
    ...snapshot, accounts: snapshot.accounts.map(account => ({ ...account, authState: "unknown" })),
  }, config, state);
  return { runtime, methods, config, directory, getSnapshot, unavailable, failNextProbe: () => { stallNext = true; },
    changeAccount: () => { principal = { type: "chatgpt", email: "other@example.test", id: "synthetic-other-owner" }; },
    signOut: () => { principal = null; }, changeDuringVerification: () => { changeAfter = 2; },
    realSettings: async () => {
      const canonical = providerSettingsCanonicalFixture();
      canonical.refreshedAt = new Date().toISOString();
      const unknown = { state: "unknown" as const, checkedAt: null, staleAfter: null, action: "retry" as const, safeReason: "unknown" as const };
      canonical.accessSources.push({ ...canonical.accessSources[1]!, id: "owner_openai_profile", vendor: "openai", eligibleModelIds: ["codex-model"], ...unknown });
      canonical.accounts.push({ ...canonical.accounts[0]!, id: "owner_openai", vendor: "openai", ...unknown });
      canonical.drivers.push({ ...canonical.drivers[1]!, id: "codex" });
      canonical.instances.push({ ...canonical.instances[1]!, id: "codex_owner", driverId: "codex", accountId: "owner_openai", accessSourceId: "owner_openai_profile", vendor: "openai", modelIds: ["codex-model"], defaultModelId: "codex-model" });
      canonical.models.push({ ...canonical.models[0]!, id: "codex-model", vendor: "openai", eligibleAccessSourceIds: ["owner_openai_profile"], dataPolicies: [{ accessSourceId: "owner_openai_profile", route: "owner_direct", disclosureKey: "owner-openai" }] });
      const store = new ProviderSettingsStore({ homePath, providerSnapshotReader: { getSnapshot: async () => canonical },
        runtimeCoordinator: { supportedActions: ["set_harness_enabled"], reconcilePending: async () => undefined,
          isRecoveryReady: () => true, applyConfiguration: async () => undefined, rollbackConfiguration: async () => undefined },
        codexNativeAccountMetadataReader: runtime.readAccount });
      await store.getSnapshot();
      settings = store;
      return vi.spyOn(store, "getSnapshot");
    },
  };
}

it.each(["signed_out", "changed"] as const)("does not retry confirmed %s through the real Settings store", async state => {
  const f = await fixture(false);
  const readSettings = await f.realSettings();
  if (state === "signed_out") f.signOut(); else f.changeDuringVerification();
  await expect(f.runtime.admission.start("owner", "sess_confirmed_failure")).rejects.toThrow("account is unavailable");
  expect(readSettings).toHaveBeenCalledOnce();
  const snapshot = await readSettings.mock.results[0]!.value;
  expect(snapshot.access.mode).toBe("writable");
  expect(codexCatalogObservation(snapshot)).toBe("authentication_required");
});

it("admits a healthy Codex session immediately after an optional observation timed out", async () => {
  const f = await fixture();
  expect(await f.runtime.readAccount()).toBeNull();
  // The next identity observation is healthy, while the optional reader is
  // still in its five-second cooldown with a null cached result.
  await expect(f.runtime.admission.start("owner", "sess_recovery")).resolves.toEqual(expect.any(String));
  await expect(f.runtime.resolveSubscription("owner", "sess_recovery")).resolves.toMatchObject({ expectedAccountId: "owner_codex" });
  expect(f.methods.length).toBeGreaterThan(1);
  expect(f.methods.slice(1).flat()).not.toContain("account/rateLimits/read");
});

it("still rejects a changed native principal after the optional observation timed out", async () => {
  const f = await fixture();
  expect(await f.runtime.readAccount()).toBeNull();
  f.changeAccount();
  await expect(f.runtime.admission.start("owner", "sess_changed")).rejects.toThrow("account is unavailable");
  expect(f.methods.length).toBeGreaterThan(1);
});

it("reobserves a temporary account probe failure once before rejecting a recovery launch", async () => {
  const f = await fixture();
  expect(await f.runtime.readAccount()).toBeNull();
  await f.runtime.admission.start("owner", "sess_recovery");
  f.getSnapshot.mockClear().mockResolvedValueOnce(f.unavailable());
  await expect(f.runtime.resolveSubscription("owner", "sess_recovery")).resolves.toMatchObject({ expectedAccountId: "owner_codex" });
  expect(f.getSnapshot).toHaveBeenCalledTimes(2);
});

it.each(["unavailable", "signed_out", "changed"] as const)("bounds retries and never admits a %s account observation", async state => {
  const f = await fixture();
  f.getSnapshot.mockResolvedValue(f.unavailable(state));
  await expect(f.runtime.admission.start("owner", "sess_rejected")).rejects.toThrow("account is unavailable");
  expect(f.getSnapshot).toHaveBeenCalledTimes(state === "unavailable" ? 2 : 1);
  expect(f.methods).toHaveLength(0);
});

it("does not adopt new consent while retrying an unavailable account observation", async () => {
  const f = await fixture();
  f.getSnapshot.mockImplementationOnce(async () => {
    await writeFile(join(f.directory, "settings.json"), JSON.stringify({ ...f.config, revision: f.config.revision + 1 }));
    return f.unavailable();
  });
  await expect(f.runtime.admission.start("owner", "sess_raced")).rejects.toThrow("account is unavailable");
  expect(f.getSnapshot).toHaveBeenCalledOnce();
  expect(f.methods).toHaveLength(0);
});

it("cold-recovers the same conversation once after a failed optional probe and lost control", async () => {
  const f = await fixture(false);
  const binding = await f.runtime.admission.start("owner", "sess_recovery");
  f.failNextProbe();
  expect(await f.runtime.readAccount()).toBeNull();
  const previous = { id: "sess_recovery", ownerId: "owner", kind: "agent", agent: "codex", projectSlug: "project" };
  const startSession = vi.fn(async () => {
    await expect(f.runtime.resolveSubscription("owner", "sess_recovery")).resolves.toMatchObject({ expectedAccountId: "owner_codex" });
    return { ok: true, status: 201, session: { ...previous, runtime: { type: "background", status: "running", createdAt: new Date().toISOString() }, backgroundRef: { id: "bg_recovered" } } };
  });
  const submitTurn = vi.fn(async () => { throw Object.assign(new Error("Synthetic lost control"), { name: "CodexControlUnavailableError" }); });
  const provider = createWorkspaceCodingAgentProvider({ agent: "codex", providerId: "codex", codexAdmission: f.runtime.admission,
    runtime: { startSession, getSession: async () => ({ ok: true, session: previous }) } as never,
    codexControl: { submitTurn } as never,
    codexEvents: { watch: async () => ({ offset: 0 }), unwatch: vi.fn() } as never,
  });
  const result = await provider.resumeTurn!({ principal: { userId: "owner" }, thread: { id: "thread_recovery", projectId: "project" },
    turn: { turnId: "turn_followup", message: "Continue the existing task" },
    resumeState: { conversationId: "sess_recovery", providerThreadId: "native_retained", nativeAccountBinding: binding },
    signal: new AbortController().signal, nextEventId: () => "evt_recovered", now: () => new Date(),
  } as never);
  expect(result).toMatchObject({ outcome: "delivered", resumeState: {
    conversationId: "sess_recovery", providerThreadId: "native_retained", nativeAccountBinding: binding, backgroundRef: { id: "bg_recovered" },
  } });
  expect(submitTurn).toHaveBeenCalledOnce();
  expect(startSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ request: expect.objectContaining({
    sessionId: "sess_recovery", providerThreadId: "native_retained", prompt: "Continue the existing task",
  }) }));
});

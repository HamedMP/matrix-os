import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { managedChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { AoedeBindingRepository } from "../../packages/gateway/src/aoede/binding-repository.js";
import { AoedeBootstrapService } from "../../packages/gateway/src/aoede/bootstrap-service.js";
import { createAoedeRoutes } from "../../packages/gateway/src/aoede/routes.js";
import { AoedeBootstrapRequestSchema } from "../../packages/contracts/src/aoede.js";
import type { VoiceCapability } from "@matrix-os/contracts/voice-session";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";

const principal = { userId: "owner_a", source: "remote" as const };
const selection = { instanceId: "fake_model", model: "model_test" };
const instance = managedChatInstances(makeAiProviderSnapshot(), [])[0]!;
const fakeCatalog = CanonicalProviderCatalogSchema.parse({ revision: "catalog_fake",
  drivers: [{ kind: "kernel", displayName: "Fake kernel", adapterVersion: "1.0.0", capabilityClass: "system_agent" }],
  instances: [{ ...instance, id: selection.instanceId, catalogRevision: "catalog_fake", defaultSelection: selection,
    models: [{ ...instance.models[0]!, id: selection.model, availability: "available" }] }],
});
const catalog = { getCatalog: vi.fn(async () => fakeCatalog) };
const capability: VoiceCapability = {
  contractVersion: 1, status: "available", surface: "web_desktop",
  transportModes: ["relayed_websocket"], turnModes: ["push_to_talk"],
  supportsInterruption: true, resume: "delivery_aware", sessionOnly: "unsupported",
  actionMode: "conversation_only", actionCancellation: "none",
  supportsInputSelection: true, supportsOutputSelection: true,
};
const request = (id: string, intent: "continue" | "new" = "continue", projectId?: string) => ({
  clientRequestId: `req_${id}`, intent, surface: "web_desktop" as const,
  ...(projectId ? { projectId } : {}),
});

describe("standalone Aoede bootstrap (real owner-local PGlite, fake readiness only)", () => {
  let chats: ChatRepository;
  let bindings: AoedeBindingRepository;
  let service: AoedeBootstrapService;
  let readiness: ReturnType<typeof vi.fn>;
  let resolveProject: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const pg = await KyselyPGlite.create();
    // kysely-pglite creates multiple logical connections over one physical
    // connection. Serialize acquisition like a one-connection Postgres pool;
    // otherwise concurrent BEGINs interleave inside the same transaction.
    const driver = pg.dialect.createDriver();
    let tail = Promise.resolve();
    let release = () => {};
    const acquire = driver.acquireConnection.bind(driver);
    driver.acquireConnection = async () => {
      const previous = tail;
      tail = new Promise<void>((resolve) => { release = resolve; });
      const unlock = release;
      await previous;
      const connection = await acquire();
      Object.assign(connection, { unlock });
      return connection;
    };
    driver.releaseConnection = async (connection) => {
      (connection as typeof connection & { unlock(): void }).unlock();
    };
    chats = new ChatRepository({ ...pg.dialect, createDriver: () => driver });
    await chats.bootstrap();
    bindings = new AoedeBindingRepository(chats);
    readiness = vi.fn(async (input) => ({ selection: input.selection ?? selection, capability }));
    resolveProject = vi.fn(async (_principal, projectId) => projectId === "project_allowed"
      ? { kind: "project", id: projectId, label: "Allowed project" } : null);
    service = new AoedeBootstrapService({ repository: bindings, catalog,
      runtimeIdentity: { machineId: "machine_a", runtimeSlot: "slot_a" },
      resolveReadiness: readiness, resolveProject,
    });
  });
  afterEach(async () => { await chats.kysely.destroy(); catalog.getCatalog.mockReset(); catalog.getCatalog.mockResolvedValue(fakeCatalog); });

  it("overlaps real bootstrap catalog and independent speech readiness on a composed cold path", async () => {
    vi.useFakeTimers();
    const speech = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 9_800));
      return capability;
    });
    catalog.getCatalog.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 5_800));
      await new Promise(resolve => setTimeout(resolve, 14_800));
      return fakeCatalog;
    });
    const composed = new AoedeBootstrapService({ repository: bindings, catalog,
      runtimeIdentity: { machineId: "machine_a", runtimeSlot: "slot_a" }, resolveProject,
      resolveSpeechCapability: speech,
      resolveReadiness: async input => {
        const ready = input.speechCapability ?? await speech();
        return { selection: input.selection, capability: ready };
      },
    });
    try {
      const start = Date.now();
      const pending = composed.bootstrap(principal, request("cold_path"));
      await vi.waitFor(() => expect(catalog.getCatalog).toHaveBeenCalled());
      expect(speech).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20_600);
      expect(await pending).toMatchObject({ capability: { status: "available" } });
      expect(Date.now() - start).toBeLessThan(25_000);
      expect(speech).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("requires a canonical default runnable route before creating any binding", async () => {
    catalog.getCatalog.mockResolvedValueOnce({ ...fakeCatalog, instances: [] });
    await expect(service.bootstrap(principal, request("no_route"))).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(await chats.kysely.selectFrom("chats").selectAll().execute()).toHaveLength(0);
    expect(readiness).not.toHaveBeenCalled();
  });

  it("bootstraps funded native conversation without probing or inventing a task route", async () => {
    catalog.getCatalog.mockRejectedValue(new Error("Task account unavailable"));
    const native = new AoedeBootstrapService({ repository: bindings, catalog,
      runtimeIdentity: { machineId: "machine_a", runtimeSlot: "slot_a" }, resolveProject,
      nativeConversationOnly: true,
      resolveReadiness: async input => ({ selection: input.selection,
        capability: { ...capability, conversationMode: "native_live", turnModes: ["hands_free"] } }),
    });
    const response = await native.bootstrap(principal, request("no_subscription"));
    expect(response.capability.status).toBe("available");
    expect(response.selection).toBeUndefined();
    expect(catalog.getCatalog).not.toHaveBeenCalled();
    expect((await chats.get({ type: "personal", ownerId: principal.userId }, response.chatId))?.chat.currentSelection).toBeUndefined();
    expect(await chats.kysely.selectFrom("chat_runs").selectAll().execute()).toHaveLength(0);
    expect((await native.bootstrap(principal, request("resume_no_subscription"))).chatId).toBe(response.chatId);
  });

  it("racing Continue and durable reload reuse one canonical conversation without dispatch", async () => {
    const results = await Promise.all([service.bootstrap(principal, request("one")), service.bootstrap(principal, request("two"))]);
    expect(results[0].chatId).toBe(results[1].chatId);
    expect(results[0].scope).toEqual({ kind: "workspace", id: "workspace", label: "Workspace" });
    const reloaded = new AoedeBootstrapService({ repository: new AoedeBindingRepository(chats), catalog,
      runtimeIdentity: { machineId: "machine_a", runtimeSlot: "slot_a" }, resolveReadiness: readiness, resolveProject });
    expect((await reloaded.bootstrap(principal, request("reload"))).chatId).toBe(results[0].chatId);
    expect(await chats.kysely.selectFrom("chats").selectAll().execute()).toHaveLength(1);
    expect(await chats.kysely.selectFrom("chat_runs").selectAll().execute()).toHaveLength(0);
  });

  it("concurrent explicit New dedupes exact request, retains old history, and survives later New", async () => {
    const old = await service.bootstrap(principal, request("initial"));
    const [a, b] = await Promise.all([service.bootstrap(principal, request("new", "new")), service.bootstrap(principal, request("new", "new"))]);
    expect(a.chatId).toBe(b.chatId);
    expect(a.chatId).not.toBe(old.chatId);
    await service.bootstrap(principal, request("later", "new"));
    expect((await service.bootstrap(principal, request("new", "new"))).chatId).toBe(a.chatId);
    expect(await chats.kysely.selectFrom("chats").selectAll().execute()).toHaveLength(3);
  });

  it("rejects different semantics with the same request identity, including scope", async () => {
    await service.bootstrap(principal, request("same"));
    await expect(service.bootstrap(principal, request("same", "new"))).rejects.toMatchObject({ code: "session_conflict" });
    await expect(service.bootstrap(principal, request("same", "continue", "project_allowed"))).rejects.toMatchObject({ code: "session_conflict" });
  });

  it("cross-scope races with one request id elect only one result and roll back the losing Chat", async () => {
    const results = await Promise.allSettled([
      service.bootstrap(principal, request("race", "new")),
      service.bootstrap(principal, request("race", "new", "project_allowed")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({ code: "session_conflict" });
    expect(await chats.kysely.selectFrom("chats").selectAll().execute()).toHaveLength(1);
  });

  it("keeps deletion tombstones; Continue and exact New retry cannot silently recreate", async () => {
    const first = await service.bootstrap(principal, request("first", "new"));
    await chats.kysely.deleteFrom("chats").where("id", "=", first.chatId).execute();
    await expect(service.bootstrap(principal, request("resume"))).rejects.toMatchObject({ code: "chat_unavailable" });
    await expect(service.bootstrap(principal, request("first", "new"))).rejects.toMatchObject({ code: "chat_unavailable" });
    const next = await service.bootstrap(principal, request("replacement", "new"));
    expect(next.chatId).not.toBe(first.chatId);
  });

  it("isolates authenticated owners, runtime slots and authorized project scope", async () => {
    const workspace = await service.bootstrap(principal, request("shared"));
    const other = await service.bootstrap({ ...principal, userId: "owner_b" }, request("shared"));
    const project = await service.bootstrap(principal, request("project", "continue", "project_allowed"));
    expect(new Set([workspace.chatId, other.chatId, project.chatId]).size).toBe(3);
    expect(project.scope).toEqual({ kind: "project", id: "project_allowed", label: "Allowed project" });
    expect((await chats.get({ type: "personal", ownerId: principal.userId }, project.chatId))?.projectId).toBe("project_allowed");
    const secondRuntime = new AoedeBootstrapService({ repository: bindings, catalog, runtimeIdentity: { machineId: "machine_a", runtimeSlot: "slot_b" }, resolveReadiness: readiness, resolveProject });
    expect((await secondRuntime.bootstrap(principal, request("shared"))).chatId).not.toBe(workspace.chatId);
    await expect(service.bootstrap(principal, request("forbidden", "continue", "project_denied"))).rejects.toMatchObject({ code: "chat_unavailable" });
  });

  it("requests the complete readiness catalog for a saved non-Codex selection", async () => {
    const first = await service.bootstrap(principal, request("initial"));
    const owner = { type: "personal" as const, ownerId: principal.userId };
    const saved = { instanceId: "claude_code_default", model: "saved" };
    const savedInstance = { ...fakeCatalog.instances[0]!, id: saved.instanceId, driverKind: "claude_code" as const,
      defaultSelection: saved, models: [{ ...fakeCatalog.instances[0]!.models[0]!, id: saved.model }] };
    catalog.getCatalog.mockResolvedValueOnce({ ...fakeCatalog,
      drivers: [...fakeCatalog.drivers, { kind: "claude_code", displayName: "Claude Code",
        adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
      instances: [...fakeCatalog.instances, savedInstance] });
    await chats.update(owner, first.chatId, { baseRevision: 0, currentSelection: saved });
    const transact = vi.spyOn(bindings, "withTransaction");
    readiness.mockImplementation(async (input) => {
      expect(transact).not.toHaveBeenCalled();
      return { selection: input.selection ?? selection, capability };
    });
    expect((await service.bootstrap(principal, request("continue"))).selection).toEqual(saved);
    expect(catalog.getCatalog).toHaveBeenLastCalledWith(principal, saved.instanceId);
    expect(transact).toHaveBeenCalledTimes(1);
  });

  it("repairs a saved model missing from its still-available instance to that instance's default and persists it", async () => {
    const first = await service.bootstrap(principal, request("initial"));
    const owner = { type: "personal" as const, ownerId: principal.userId };
    // Placeholder written by an older build; the instance is available but this model id is not in the catalog.
    const stale = { instanceId: selection.instanceId, model: "provider-default" };
    await chats.update(owner, first.chatId, { baseRevision: 0, currentSelection: stale });
    const repaired = await service.bootstrap(principal, request("repair"));
    expect(repaired.chatId).toBe(first.chatId);
    expect(repaired.selection).toEqual(selection);
    expect(repaired.capability.status).toBe("available");
    expect(readiness).toHaveBeenLastCalledWith(expect.objectContaining({ selection }));
    const persisted = await chats.get(owner, first.chatId);
    expect(persisted?.chat.currentSelection).toEqual(selection);
    expect(persisted?.chat.revision).toBe(2);
    // The repair is durable: the next Continue sees a runnable saved route and writes nothing.
    expect((await service.bootstrap(principal, request("again"))).selection).toEqual(selection);
    expect((await chats.get(owner, first.chatId))?.chat.revision).toBe(2);
  });

  it("never substitutes another Provider instance for a saved route whose instance is unavailable", async () => {
    const first = await service.bootstrap(principal, request("initial"));
    const owner = { type: "personal" as const, ownerId: principal.userId };
    const saved = { instanceId: "gone_instance", model: "gone" };
    await chats.update(owner, first.chatId, { baseRevision: 0, currentSelection: saved });
    const result = await service.bootstrap(principal, request("continue"));
    expect(result.selection).toEqual(saved);
    expect(result.capability).toMatchObject({ status: "unavailable", reason: "provider_unavailable" });
    expect(readiness).toHaveBeenLastCalledWith(expect.objectContaining({ selection: saved }));
    expect((await chats.get(owner, first.chatId))?.chat.currentSelection).toEqual(saved);
  });

  it("strict authenticated HTTP rejects owner/runtime/tool fields and bounds bodies with structured safe errors", async () => {
    const app = createAoedeRoutes({ service, requirePrincipal: () => principal });
    const post = (body: unknown) => app.request("http://test/api/aoede/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const key of ["ownerId", "runtimeId", "chatId", "tools"]) {
      expect(AoedeBootstrapRequestSchema.safeParse({ ...request("invalid"), [key]: "injected" }).success).toBe(false);
      const res = await post({ ...request("invalid"), [key]: "injected" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: "session_conflict", retryable: false, recovery: "none" } });
    }
    const tooLarge = await post({ ...request("large"), junk: "x".repeat(4096) });
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json()).error).toHaveProperty("recovery");
    const success = await post(request("valid"));
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ selection, capability });
    const anonymous = createAoedeRoutes({ service, requirePrincipal: () => { throw new MissingRequestPrincipalError(); } });
    const unauthorized = await anonymous.request("http://test/api/aoede/bootstrap", { method: "POST", body: JSON.stringify(request("anon")) });
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json()).error.code).toBe("permission_denied");
    readiness.mockRejectedValue(new Error("private provider secret"));
    const failed = await post(request("fail"));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("private");
  });
});

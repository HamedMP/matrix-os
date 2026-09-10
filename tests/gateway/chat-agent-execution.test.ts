import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KyselyPGlite } from "kysely-pglite";
import { z } from "zod/v4";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import { createCanonicalChatRuntime } from "../../packages/gateway/src/chat/runtime.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter, type CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

const owner = { type: "personal" as const, ownerId: "owner_bot_runs" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol" };
const agentSelection = { instanceId: "hermes_default", model: "openai:gpt-5.6-sol" };
const mention = (kind: "agent" | "chat", id: string) => ({
  type: "resource_reference" as const, resource: { kind, id, label: "Selected reference" },
});

describe("Hermes Agent invocation through canonical Chat", () => {
  let home: string;
  let repository: ChatRepository;
  let agents: ChatAgentStore;
  let orchestrator: CanonicalChatOrchestrator;
  let calls: Array<{ driver: string; resumed: boolean; input: CanonicalProviderRunInput }>;
  let enabled: boolean;
  let release: (() => void) | undefined;
  let hold: Promise<void> | undefined;
  let failHermes: boolean;
  let agentId: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-agent-execution-"));
    repository = new ChatRepository((await KyselyPGlite.create()).dialect);
    await repository.bootstrap();
    enabled = true; failHermes = false; calls = []; release = undefined; hold = undefined;
    const catalog = createCanonicalProviderCatalogFixture();
    const hermes = { ...catalog.instances[0]!, id: "hermes_default", driverKind: "hermes" as const,
      models: [{ ...catalog.instances[0]!.models[0]!, id: agentSelection.model }],
      supports: { ...catalog.instances[0]!.supports, resources: [], permissionModes: ["full_access"] },
    };
    catalog.drivers.push({ ...catalog.drivers[0]!, kind: "hermes", displayName: "Hermes" });
    catalog.instances.push(hermes);
    const adapter = (driver: "codex" | "hermes"): CanonicalChatProviderAdapter => {
      const execute = async function* (input: CanonicalProviderRunInput, resumed: boolean) {
        calls.push({ driver, resumed, input });
        const pending = hold; hold = undefined;
        if (pending) await pending;
        yield { type: "state.updated" as const, state: { sessionId: `${driver}_${input.runId}` } };
        yield { type: "assistant.delta" as const, delta: driver === "hermes" ? "Agent result: Thursday review." : "Original Chat response." };
        yield { type: "run.completed" as const, outcome: driver === "hermes" && failHermes ? "failed" as const : "completed" as const };
      };
      return {
        driverKind: driver, stateSchemaVersion: 1,
        parseState: (value) => z.object({ sessionId: z.string() }).parse(value), serializeState: (value) => value,
        start: (input) => execute(input, false), resume: (input) => execute(input, true),
      };
    };
    const runtime = await createCanonicalChatRuntime({
      homePath: home, enabled: () => enabled,
      repository, catalog: { getCatalog: async () => catalog },
      adapters: new CanonicalChatProviderRegistry([adapter("codex"), adapter("hermes")]),
    });
    agents = runtime.agents;
    orchestrator = runtime.orchestrator;
    await repository.create(owner, { id: "chat_parent", clientRequestId: "req_parent", title: "Original Chat", currentSelection: selection });
    agentId = (await agents.create(owner, {
      clientRequestId: "req_agent", name: "Partner helper", description: "Prepare partner decisions",
      instructions: "Separate decisions from open questions.", selection: agentSelection,
    })).id;
  });
  afterEach(async () => {
    release?.();
    await orchestrator.close();
    await agents.close();
    await repository.kysely.destroy();
    await rm(home, { recursive: true, force: true });
  });

  async function input(requestId: string, parts: CanonicalCreateChatTurnRequest["parts"]) {
    return {
      clientRequestId: requestId, baseRevision: (await repository.get(owner, "chat_parent"))!.chat.revision,
      selection, interactionMode: "default", permissionMode: "full_access", parts,
    };
  }
  async function complete() {
    await vi.waitFor(() => expect(orchestrator.activeCount).toBe(0), { timeout: 5_000 });
  }
  async function send(requestId: string, parts: CanonicalCreateChatTurnRequest["parts"]) {
    const result = await orchestrator.admitTurn(principal, owner, "chat_parent", await input(requestId, parts));
    await complete();
    return result;
  }

  it("runs Hermes in place, preserves the default binding and transcript, and returns to the original harness", async () => {
    await send("req_normal", [{ type: "text", text: "Keep this original conversation" }]);
    const before = await repository.getDetailPage(owner, "chat_parent", { limit: 100 });
    const admitted = await send("req_bot_turn", [{ type: "text", text: "Prepare the partner review" }, mention("agent", agentId)]);
    expect(admitted.run.driverKind).toBe("hermes");
    expect(admitted.run.context?.agent).toMatchObject({ id: agentId, name: "Partner helper", revision: 1 });
    expect(admitted.record.providerBinding).toEqual(before!.record.providerBinding);
    expect(admitted.record.chat.currentSelection).toEqual(selection);
    const after = await repository.getDetailPage(owner, "chat_parent", { limit: 100 });
    expect(after!.messages.slice(0, before!.messages.length)).toEqual(before!.messages);
    expect(after!.runs.at(-1)?.context?.agent?.id).toBe(agentId);
    const invoked = calls.find((call) => call.driver === "hermes")!;
    expect(invoked.resumed).toBe(false);
    expect(invoked.input.prompt).toContain("Separate decisions from open questions.");
    expect(invoked.input.prompt).toContain("Keep this original conversation");
    await send("req_after_bot", [{ type: "text", text: "Continue with the result" }]);
    expect(calls.at(-1)?.driver).toBe("codex");
    expect(calls.at(-1)?.input.prompt).toContain("Agent result: Thursday review.");
    expect((await repository.get(owner, "chat_parent"))!.chat.currentSelection).toEqual(selection);
  });

  it("does not bind a new Chat to an invoked Bot before its first ordinary turn", async () => {
    const invoked = await send("req_bot_first", [{ type: "text", text: "First task" }, mention("agent", agentId)]);
    expect(invoked.record.providerBinding).toBeUndefined();
    expect(invoked.record.chat.currentSelection).toEqual(selection);
    const normal = await send("req_regular_second", [{ type: "text", text: "Continue normally" }]);
    expect(normal.record.providerBinding?.driverKind).toBe("codex");
  });

  it("commits context before dispatch and keeps its contents stable on retry", async () => {
    failHermes = true;
    const admitted = await send("req_bot_failed", [{ type: "text", text: "Draft a review" }, mention("agent", agentId)]);
    await agents.update(owner, agentId, { baseRevision: 1, instructions: "A different role for future work" });
    failHermes = false;
    const retry = await orchestrator.retryTurn(principal, owner, "chat_parent", admitted.turn.id, {
      clientRequestId: "req_retry_bot", baseRevision: (await repository.get(owner, "chat_parent"))!.chat.revision,
    });
    await complete();
    expect(retry.run.context).toEqual(admitted.run.context);
    expect(calls.at(-1)?.input.prompt).toContain("Separate decisions from open questions.");
    expect(calls.at(-1)?.input.prompt).not.toContain("A different role for future work");
    expect(calls.at(-1)?.resumed).toBe(false);
  });

  it("deduplicates an accepted Agent turn and rejects a changed request with its idempotency key", async () => {
    const request = await input("req_idempotent_bot", [{ type: "text", text: "One job" }, mention("agent", agentId)]);
    const first = await orchestrator.admitTurn(principal, owner, "chat_parent", request);
    await complete();
    const duplicate = await orchestrator.admitTurn(principal, owner, "chat_parent", request);
    expect(duplicate.run.id).toBe(first.run.id);
    expect(calls).toHaveLength(1);
    await expect(orchestrator.admitTurn(principal, owner, "chat_parent", {
      ...request, parts: [{ type: "text", text: "Changed job" }, mention("agent", agentId)],
    })).rejects.toMatchObject({ safeError: { code: "chat_conflict" } });
    expect(calls).toHaveLength(1);
  });

  it("keeps Agent identity and snapshot across durable queue admission and dispatch", async () => {
    hold = new Promise<void>((resolve) => { release = resolve; });
    await orchestrator.admitTurn(principal, owner, "chat_parent", await input("req_running", [{ type: "text", text: "Original work" }]));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const queued = await orchestrator.enqueueQueuedTurn(principal, owner, "chat_parent", await input("req_queued_bot", [
      { type: "text", text: "Then prepare review" }, mention("agent", agentId),
    ]));
    expect(queued.queuedTurn.context?.agent?.id).toBe(agentId);
    await agents.update(owner, agentId, { baseRevision: 1, instructions: "Later version" });
    release!();
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 5_000 });
    await complete();
    expect(calls[1]!.driver).toBe("hermes");
    expect(calls[1]!.input.prompt).toContain("Separate decisions from open questions.");
    expect(calls[1]!.input.prompt).toContain("Original Chat response.");
    expect((await repository.get(owner, "chat_parent"))!.chat.currentSelection).toEqual(selection);
  });


  it("snapshots another owned Chat and keeps its text stable after the source changes", async () => {
    await repository.create(owner, { id: "chat_source", clientRequestId: "req_source", title: "Source", currentSelection: selection });
    await orchestrator.admitTurn(principal, owner, "chat_source", {
      clientRequestId: "req_source_text", baseRevision: (await repository.get(owner, "chat_source"))!.chat.revision, selection, interactionMode: "default", permissionMode: "full_access",
      parts: [{ type: "text", text: "Budget is 400 units" }],
    });
    await complete();
    failHermes = true;
    const first = await send("req_reference", [{ type: "text", text: "Prepare review" }, mention("agent", agentId), mention("chat", "chat_source")]);
    expect(calls.at(-1)?.input.prompt).toContain("Budget is 400 units");
    expect(first.run.context?.chats[0]?.title).toBe("Source");
    await orchestrator.admitTurn(principal, owner, "chat_source", {
      clientRequestId: "req_source_changed", baseRevision: (await repository.get(owner, "chat_source"))!.chat.revision,
      selection, interactionMode: "default", permissionMode: "full_access", parts: [{ type: "text", text: "Budget changed to 900 units" }],
    });
    await complete();
    failHermes = false;
    const retried = await orchestrator.retryTurn(principal, owner, "chat_parent", first.turn.id, {
      clientRequestId: "req_reference_retry", baseRevision: (await repository.get(owner, "chat_parent"))!.chat.revision,
    });
    await complete();
    expect(retried.run.context).toEqual(first.run.context);
    expect(calls.at(-1)?.input.prompt).not.toContain("Budget changed to 900 units");
  });

  it("rechecks the switch before dispatching an already queued Agent", async () => {
    hold = new Promise<void>((resolve) => { release = resolve; });
    await orchestrator.admitTurn(principal, owner, "chat_parent", await input("req_hold", [{ type: "text", text: "Current work" }]));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await orchestrator.enqueueQueuedTurn(principal, owner, "chat_parent", await input("req_later", [mention("agent", agentId)]));
    enabled = false;
    release!();
    await vi.waitFor(async () => expect((await repository.getDetailPage(owner, "chat_parent", { limit: 100 }))!.runs).toHaveLength(2));
    await complete();
    expect(calls).toHaveLength(1);
    expect((await repository.getDetailPage(owner, "chat_parent", { limit: 100 }))!.runs.at(-1)?.status).toBe("failed");
  });

  it("resumes an ordinary queued turn after an Agent with the newly completed Agent result", async () => {
    hold = new Promise<void>((resolve) => { release = resolve; });
    await orchestrator.admitTurn(principal, owner, "chat_parent", await input("req_hold_bot", [mention("agent", agentId)]));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await orchestrator.enqueueQueuedTurn(principal, owner, "chat_parent", await input("req_later_normal", [{ type: "text", text: "Continue normally" }]));
    release!();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await complete();
    expect(calls[1]?.driver).toBe("codex");
    expect(calls[1]?.input.prompt).toContain("Agent result: Thursday review.");
    expect((await repository.get(owner, "chat_parent"))!.providerBinding?.driverKind).toBe("codex");
  });


  it("preserves references during queue text edits and cannot steer an Agent into the active Run", async () => {
    hold = new Promise<void>((resolve) => { release = resolve; });
    const active = await orchestrator.admitTurn(principal, owner, "chat_parent", await input("req_edit_running", [{ type: "text", text: "Working" }]));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const queued = (await orchestrator.enqueueQueuedTurn(principal, owner, "chat_parent", await input("req_edit_queued", [
      { type: "text", text: "Draft one" }, mention("agent", agentId),
    ]))).queuedTurn;
    const change = { chatId: "chat_parent", queuedTurnId: queued.id, clientRequestId: "req_edit_queue", updatedAt: new Date().toISOString(),
      baseRevision: (await repository.get(owner, "chat_parent"))!.chat.revision };
    await expect(repository.updateQueuedTurn(owner, { ...change, parts: [{ type: "text", text: "Lose reference" }] }))
      .rejects.toMatchObject({ name: "ChatConflictError" });
    const edited = await repository.updateQueuedTurn(owner, { ...change, parts: [{ type: "text", text: "Draft two" }, mention("agent", agentId)] });
    expect(edited.queuedTurn.context).toEqual(queued.context);
    // Simulate a harness supporting same-run steering; mention semantics must still forbid this path.
    await repository.kysely.updateTable("chat_runs").set({ capability_snapshot: JSON.stringify({ ...active.run.capabilitySnapshot, steering: "same_run" }) })
      .where("id", "=", active.run.id).execute();
    await expect(repository.beginQueuedTurnSteer(owner, {
      ...change, clientRequestId: "req_forbidden_steer", runId: active.run.id, expectedTurnId: active.turn.id,
      steerId: "steer_agent_queue", messageId: "msg_agent_steer", createdAt: change.updatedAt,
    })).rejects.toMatchObject({ name: "ChatConflictError" });
    release!();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await complete();
    expect(calls[1]?.input.prompt).toContain("Draft two");
    expect(calls[1]?.driver).toBe("hermes");
  });

  it("rejects disabled and archived Agent invocations before changing Chat state", async () => {
    enabled = false;
    await expect(send("req_disabled", [mention("agent", agentId)])).rejects.toMatchObject({ safeError: { code: "capability_mismatch" } });
    expect((await repository.get(owner, "chat_parent"))!.chat.messageCount).toBe(0);
    expect(calls).toEqual([]);
    enabled = true;
    await agents.update(owner, agentId, { baseRevision: 1, archived: true });
    await expect(send("req_archived", [mention("agent", agentId)])).rejects.toMatchObject({ safeError: { code: "resource_unavailable" } });
    expect(calls).toEqual([]);
  });
});

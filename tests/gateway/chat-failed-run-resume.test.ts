import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { EventEmitter } from "node:events";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_recovery" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const selection = { instanceId: "pi_default", model: "test_model" };
const catalog = CanonicalProviderCatalogSchema.parse({
  revision: "recovery_catalog",
  drivers: [{ kind: "pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
  instances: [{
    id: selection.instanceId, driverKind: "pi", displayName: "Pi", availability: "available",
    workspaceRequirement: "project_optional", catalogRevision: "recovery_catalog",
    models: [{ id: selection.model, displayName: "Test", availability: "available", capabilities: [], supportsVision: false, supportsToolUse: false }],
    options: [], skills: [], commands: [], setupActions: [],
    supports: {
      rootChat: true, resume: true, cancellation: true, steering: "same_run", attachments: [], tools: [],
      approvals: false, userInput: false, worktrees: "optional", resources: [],
      interactionModes: ["default"], permissionModes: ["supervised"],
    },
  }],
});

describe("Chat native session continuity", () => {
  let repository: ChatRepository;
  beforeEach(async () => {
    const database = await KyselyPGlite.create();
    repository = new ChatRepository(database.dialect);
    await repository.bootstrap();
  });
  afterEach(async () => { await repository.kysely.destroy(); });

  it.each([
    { outcome: "failed", queued: false }, { outcome: "aborted", queued: false },
    { outcome: "failed", queued: true }, { outcome: "aborted", queued: true },
  ] as const)("continues the checkpoint after $outcome (queued=$queued)", async ({ outcome, queued }) => {
    let release!: () => void;
    const finish = new Promise<void>((resolve) => { release = resolve; });
    // The external provider's saved conversation contains the completed reads,
    // even though its run subsequently times out. The follow-up must resume it.
    const provider: CanonicalChatProviderAdapter<{ sessionId: string }> = {
      driverKind: "pi", stateSchemaVersion: 1,
      parseState: (state) => state as { sessionId: string },
      serializeState: (state) => state,
      async *start() {
        yield { type: "state.updated", state: { sessionId: "native_with_40_reads" } };
        yield { type: "assistant.delta", delta: "STEP 40" };
        await finish;
        yield { type: "run.completed", outcome };
      },
      async *resume(input) {
        expect(input.resumeState).toEqual({ sessionId: "native_with_40_reads" });
        yield { type: "assistant.delta", delta: "RECOVERY_OK 40" };
        yield { type: "run.completed", outcome: "completed" };
      },
    };
    const orchestrator = new CanonicalChatOrchestrator({
      repository, catalog: { getCatalog: async () => catalog },
      adapters: new CanonicalChatProviderRegistry([provider]),
    });
    await repository.create(owner, { id: "chat_recovery", clientRequestId: "req_create_recovery", title: "Recovery" });
    const admission = { selection, interactionMode: "default", permissionMode: "supervised" };
    await orchestrator.admitTurn(principal, owner, "chat_recovery", {
      ...admission, baseRevision: 0, clientRequestId: "req_initial",
      parts: [{ type: "text", text: "Read 40 steps" }],
    });
    if (queued) {
      await vi.waitFor(async () => {
        const history = await repository.exportChat(owner, "chat_recovery");
        expect(history?.messages.at(-1)?.parts).toEqual([{ type: "text", text: "STEP 40" }]);
      });
      const active = await repository.get(owner, "chat_recovery");
      await orchestrator.enqueueQueuedTurn(principal, owner, "chat_recovery", {
        ...admission, baseRevision: active!.chat.revision, clientRequestId: "req_followup",
        parts: [{ type: "text", text: "Recall the last completed step" }],
      });
      release();
    } else {
      release();
      await orchestrator.drain();
      const failed = await repository.get(owner, "chat_recovery");
      await orchestrator.admitTurn(principal, owner, "chat_recovery", {
        ...admission, baseRevision: failed!.chat.revision, clientRequestId: "req_followup",
        parts: [{ type: "text", text: "Recall the last completed step" }],
      });
    }
    await orchestrator.drain();
    const history = await repository.exportChat(owner, "chat_recovery");
    expect(history?.messages.at(-1)?.parts).toEqual([{ type: "text", text: "RECOVERY_OK 40" }]);
    expect(history?.runs.map((run) => run.status)).toEqual([outcome, "completed"]);
  });

  it.each([false, true])("completes Claude Steer with distinct messages and persisted activities (thinking=%s)", async (thinking) => {
    const claudeSelection = { instanceId: "claude_default", model: "test_model" };
    const claudeCatalog = CanonicalProviderCatalogSchema.parse({
      ...catalog,
      drivers: [{ ...catalog.drivers[0], kind: "claude_code" }],
      instances: [{ ...catalog.instances[0], id: claudeSelection.instanceId, driverKind: "claude_code" }],
    });
    let launches = 0;
    let resumeOutput: (() => void) | undefined;
    const provider = createClaudeChatProviderAdapter({
      homePath: "/safe/project", resolveCredentialEnv: async () => ({}),
      spawnFn() {
        const resumed = launches++ > 0;
        const process = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(),
          kill() { queueMicrotask(() => process.emit("exit", null, "SIGTERM")); return true; },
        });
        const emitOutput = () => {
          const lines = [
            { type: "system", subtype: "init", session_id: "claude_native_session" },
            ...(thinking ? [
              { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "thinking" } } },
              { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
            ] : []),
            { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
            { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: resumed ? "after steer" : "before steer" } } },
            { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
          ];
          for (const line of lines) process.stdout.emit("data", Buffer.from(`${JSON.stringify(line)}\n`));
          if (resumed) {
            process.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", result: "after steer" })}\n`));
            process.emit("exit", 0, null);
          }
        };
        if (resumed) resumeOutput = emitOutput;
        else queueMicrotask(emitOutput);
        return process;
      },
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository, catalog: { getCatalog: async () => claudeCatalog },
      adapters: new CanonicalChatProviderRegistry([provider]),
    });
    await repository.create(owner, { id: "chat_steer", clientRequestId: "req_create_steer", title: "Steer" });
    const accepted = await orchestrator.admitTurn(principal, owner, "chat_steer", {
      selection: claudeSelection, interactionMode: "default", permissionMode: "supervised",
      baseRevision: 0, clientRequestId: "req_initial_steer", parts: [{ type: "text", text: "Review" }],
    });
    try {
      await vi.waitFor(async () => {
        const history = await repository.exportChat(owner, "chat_steer");
        expect(history?.messages.at(-1)?.parts).toEqual([{ type: "text", text: "before steer" }]);
      });
      await orchestrator.steerRun(owner, "chat_steer", accepted.run.id, {
        expectedTurnId: accepted.turn.id, clientRequestId: "req_steer_now",
        parts: [{ type: "text", text: "Correct scope" }],
      });
      // This fixture's single-connection PGlite driver does not isolate
      // concurrent BEGIN/COMMIT calls. Emit the resumed CLI output after ack;
      // These regressions cover message identity and persisted Thinking
      // lifecycle transitions, not production transaction concurrency.
      await vi.waitFor(() => expect(resumeOutput).toBeDefined());
      resumeOutput!();
      await orchestrator.drain();
      const history = await repository.exportChat(owner, "chat_steer");
      expect(history?.runs).toMatchObject([{ id: accepted.run.id, status: "completed" }]);
      expect(history?.messages.map((message) => message.parts)).toEqual([
        [{ type: "text", text: "Review" }], [{ type: "text", text: "before steer" }],
        [{ type: "text", text: "Correct scope" }], [{ type: "text", text: "after steer" }],
      ]);
      expect(history?.activities.some((activity) => activity.type === "run.error")).toBe(false);
      if (thinking) {
        const activities = history!.activities.filter((activity) => (
          activity.type === "agent.activity" && activity.kind === "reasoning"
        ));
        expect(activities).toHaveLength(2);
        expect(activities).toEqual([
          expect.objectContaining({ runId: accepted.run.id, kind: "reasoning", status: "completed" }),
          expect.objectContaining({ runId: accepted.run.id, kind: "reasoning", status: "completed" }),
        ]);
        expect(new Set(activities.map((activity) => activity.id)).size).toBe(2);
      }
    } finally { await orchestrator.close(); }
  });
});

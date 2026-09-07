import { KyselyPGlite } from "kysely-pglite";
import { expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";

it("persists a form, authorizes its answer, and resumes the same provider run", async () => {
  const db = await KyselyPGlite.create();
  const repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  const owner = { type: "personal" as const, ownerId: "owner_input" };
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const submitInput = vi.fn(async () => { release(); });
  const provider: CanonicalChatProviderAdapter = {
    driverKind: "codex", stateSchemaVersion: 1, parseState: (v) => v, serializeState: (v) => v, submitInput,
    async *start() {
      yield { type: "state.updated", state: { sessionId: "native_input" } };
      yield { type: "input.requested", requestId: "req_prompt", title: "Permission", input: {
        requestId: "req_prompt", threadId: "thread_input", title: "Permission", safeDescription: "Allow once?", required: true,
        correlationId: "corr_input", questions: [{ questionId: "question_permission", header: "Permission", question: "Allow once?", secret: false, allowOther: false }],
      } };
      await released;
      yield { type: "input.resolved", requestId: "req_prompt" };
      yield { type: "run.completed", outcome: "completed" };
    },
  };
  const catalog = CanonicalProviderCatalogSchema.parse({ revision: "catalog_input", drivers: [{ kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
    instances: [{ id: "codex_default", driverKind: "codex", displayName: "Codex", availability: "available", workspaceRequirement: "project_optional", catalogRevision: "catalog_input",
      models: [{ id: "model", displayName: "Model", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }],
      options: [], skills: [], commands: [], setupActions: [], supports: { rootChat: true, resume: true, cancellation: true, steering: "none", attachments: [], tools: [], approvals: true, userInput: true, worktrees: "optional", resources: [], interactionModes: ["default"], permissionModes: ["supervised"] },
    }],
  });
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([provider]) });
  try {
    await repository.create(owner, { id: "chat_input", clientRequestId: "req_create", title: "Input" });
    const admitted = await orchestrator.admitTurn({ userId: owner.ownerId, source: "jwt" }, owner, "chat_input", {
      clientRequestId: "req_turn", baseRevision: 0, parts: [{ type: "text", text: "Connect" }], selection: { instanceId: "codex_default", model: "model" }, interactionMode: "default", permissionMode: "supervised",
    });
    await vi.waitFor(async () => expect(await repository.getPendingInput(owner, { chatId: "chat_input", runId: admitted.run.id, requestId: "req_prompt" })).not.toBeNull());
    const answer = { clientRequestId: "req_answer", answers: { question_permission: ["Allow once"] } };
    await expect(orchestrator.submitInput({ ...owner, ownerId: "other" }, "chat_input", admitted.run.id, "req_prompt", answer)).rejects.toMatchObject({ status: 409 });
    await expect(orchestrator.submitInput(owner, "chat_input", admitted.run.id, "req_missing", answer)).rejects.toMatchObject({ status: 409 });
    expect(submitInput).not.toHaveBeenCalled();
    await expect(orchestrator.submitInput(owner, "chat_input", admitted.run.id, "req_prompt", answer)).resolves.toEqual({ requestId: "req_prompt", submission: "accepted" });
    expect(submitInput).toHaveBeenCalledWith(expect.objectContaining({ state: { sessionId: "native_input" }, answers: answer.answers }));
    await orchestrator.drain();
    expect(await repository.getPendingInput(owner, { chatId: "chat_input", runId: admitted.run.id, requestId: "req_prompt" })).toBeNull();
  } finally { release(); await orchestrator.drain(); await repository.kysely.destroy(); }
}, 20_000);

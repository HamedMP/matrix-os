import {
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { KyselyPGlite } from "kysely-pglite";
import { expect, it, vi } from "vitest";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import {
  CanonicalChatProviderRegistry,
  type CanonicalChatProviderAdapter,
} from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_orchestrator" };
const principal = { userId: owner.ownerId, source: "jwt" as const };

function catalog(): CanonicalProviderCatalog {
  return CanonicalProviderCatalogSchema.parse({
    revision: "catalog_orchestrator",
    drivers: [{
      kind: "codex",
      displayName: "Codex",
      adapterVersion: "1.0.0",
      capabilityClass: "coding_agent",
    }],
    instances: [{
      id: "codex_default",
      driverKind: "codex",
      displayName: "Codex",
      availability: "available",
      workspaceRequirement: "project_optional",
      catalogRevision: "catalog_orchestrator",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        availability: "available",
        capabilities: ["reasoning", "tools"],
        supportsVision: false,
        supportsToolUse: true,
      }],
      options: [],
      skills: [],
      commands: [],
      setupActions: [],
      supports: {
        rootChat: true,
        resume: true,
        cancellation: true,
        steering: "same_run",
        attachments: ["file", "image", "structured_ref"],
        tools: [],
        approvals: true,
        userInput: true,
        worktrees: "optional",
        resources: ["file", "folder", "project", "task", "app", "terminal_session"],
        interactionModes: ["default"],
        permissionModes: ["supervised"],
      },
    }],
  });
}

function adapter(
  start: CanonicalChatProviderAdapter<{ sessionId: string }>["start"],
): CanonicalChatProviderAdapter<{ sessionId: string }> {
  return {
    driverKind: "codex",
    stateSchemaVersion: 1,
    parseState(value) {
      if (!value || typeof value !== "object" || typeof (value as { sessionId?: unknown }).sessionId !== "string") {
        throw new Error("invalid state");
      }
      return value as { sessionId: string };
    },
    serializeState: (value) => value,
    start,
  };
}

it("admits answers before later steering even when the answer repository read is slow", async () => {
  const pglite = await KyselyPGlite.create();
  const repository = new ChatRepository(pglite.dialect);
  await repository.bootstrap();
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  let releaseRead!: () => void;
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const delivered: string[] = [];
  const provider = {
    ...adapter(async function* () {
      yield { type: "state.updated" as const, state: { sessionId: "native_input" } };
      yield { type: "input.requested" as const, requestId: "input_source", title: "Source", questions: [{ questionId: "source", header: "Source", question: "Which source?", allowOther: true, secret: false }] };
      await providerGate;
      yield { type: "run.completed" as const, outcome: "completed" as const };
    }),
    submitInput: async () => { delivered.push("answer"); },
    steer: async () => { delivered.push("steer"); },
  };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog() }, adapters: new CanonicalChatProviderRegistry([provider]) });
  try {
    await repository.create(owner, { id: "chat_order", clientRequestId: "req_create_order", title: "Order" });
    const admitted = await orchestrator.admitTurn(principal, owner, "chat_order", {
      clientRequestId: "req_turn", baseRevision: 0, parts: [{ type: "text", text: "choose" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised",
    });
    await vi.waitFor(async () => expect((await repository.get(owner, "chat_order"))?.activeRun?.status).toBe("waiting_for_input"));
    const getInputState = repository.getInputState.bind(repository);
    let reading = false;
    vi.spyOn(repository, "getInputState").mockImplementationOnce(async (...args) => { reading = true; await readGate; return getInputState(...args); });
    const beginSteer = vi.spyOn(repository, "beginSteer");
    const answer = orchestrator.submitInput(owner, "chat_order", admitted.run.id, "input_source", { clientRequestId: "req_answer", structuredAnswers: { source: ["Linear"] } });
    await vi.waitFor(() => expect(reading).toBe(true));
    const steer = orchestrator.steerRun(owner, "chat_order", admitted.run.id, { clientRequestId: "req_steer", expectedTurnId: admitted.turn.id, parts: [{ type: "text", text: "use linear instead" }] });
    // Give an un-serialized steering request enough time to pass its own DB preamble.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(beginSteer).not.toHaveBeenCalled();
    releaseRead(); await Promise.all([answer, steer]);
    expect(delivered).toEqual(["answer", "steer"]);
  } finally {
    releaseRead(); releaseProvider();
    await orchestrator.drain(); await orchestrator.close();
    await repository.kysely.destroy(); vi.restoreAllMocks();
  }
});

import {
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import {
  CanonicalChatProviderRegistry,
  type CanonicalChatProviderAdapter,
} from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

import { Hono } from "hono";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";
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

describe("canonical approval service provenance", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.kysely.destroy();
  });

  it.each([true, false])("preserves the proof boundary through route/service/orchestrator (proof=%s)", async (withProof) => {
    await repository.create(owner, {
      id: "chat_approval",
      clientRequestId: "req_create_approval",
      title: "Approval",
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remoteExecution = vi.fn();
    const submitApproval = vi.fn(async (input: { platformApprovalProof?: string }) => {
      release();
      if (input.platformApprovalProof !== "platform-signed-fixture-proof") throw new Error("Authenticated approval proof unavailable");
      remoteExecution();
    });
    const provider = {
      ...adapter(async function* () {
        yield { type: "state.updated" as const, state: { sessionId: "native_approval" } };
        yield {
          type: "approval.requested" as const,
          approvalId: "appr_command",
          title: "Run command",
          risk: "medium" as const,
          allowedDecisions: ["approve" as const, "decline" as const],
        };
        await released;
        yield {
          type: "approval.resolved" as const,
          approvalId: "appr_command",
          decision: "approve" as const,
        };
        yield { type: "run.completed" as const, outcome: "completed" as const };
      }),
      submitApproval,
    };
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
    });
    const admitted = await orchestrator.admitTurn(principal, owner, "chat_approval", {
      clientRequestId: "req_approval_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "run it" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await vi.waitFor(async () => {
      expect((await repository.exportChat(owner, "chat_approval"))?.activities)
        .toEqual(expect.arrayContaining([expect.objectContaining({
          type: "approval.requested",
          approvalId: "appr_command",
        })]));
    });

    const service = createCanonicalChatService(repository, { orchestrator });
    const app = new Hono();
    app.route("/", createCanonicalChatRoutes({ service, getPrincipal: () => principal }));
    const response = await app.request(`/api/chats/chat_approval/runs/${admitted.run.id}/approvals/appr_command`, {
      method: "POST", headers: { "content-type": "application/json",
        ...(withProof ? { "x-matrix-custom-mcp-approval-proof": "platform-signed-fixture-proof" } : {}) },
      body: JSON.stringify({ clientRequestId: "req_approval_decision", decision: "approve" }),
    });
    await orchestrator.drain();
    expect(remoteExecution).toHaveBeenCalledTimes(withProof ? 1 : 0);
    expect(response.status).toBe(withProof ? 200 : 503);
    if (!withProof) {
      expect(submitApproval.mock.calls[0]?.[0]).not.toHaveProperty("platformApprovalProof");
      return;
    }
    expect(await response.json()).toEqual({ approvalId: "appr_command", decision: "approve", submission: "accepted" });
    expect(submitApproval).toHaveBeenCalledWith(expect.objectContaining({
      state: { sessionId: "native_approval" },
      approvalId: "appr_command",
      decision: "approve",
      clientRequestId: "req_approval_decision",
      platformApprovalProof: "platform-signed-fixture-proof",
    }));
    expect(submitApproval).toHaveBeenCalledOnce();
  });

});

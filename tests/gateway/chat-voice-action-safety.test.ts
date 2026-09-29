import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import {
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import {
  canonicalJsonStringify,
  normalizedArgumentDigest,
  truthfulCancellationGranularity,
} from "../../packages/gateway/src/chat/argument-digest.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import {
  CanonicalChatProviderRegistry,
  type CanonicalChatProviderAdapter,
} from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_action_safety" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const selection = { instanceId: "codex_default", model: "gpt-5.6-sol" };
const proposedArgs = { op: "send_email", to: "owner@example.com", subject: "launch" };
const proposedDigest = normalizedArgumentDigest(proposedArgs);
const differentDigest = normalizedArgumentDigest({ ...proposedArgs, to: "attacker@example.com" });

function catalog(supports: Record<string, unknown> = {}): CanonicalProviderCatalog {
  return CanonicalProviderCatalogSchema.parse({
    revision: "catalog_action_safety",
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
      catalogRevision: "catalog_action_safety",
      models: [{
        id: selection.model,
        displayName: "GPT-5.6-Sol",
        availability: "available",
        capabilities: ["tools"],
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
        attachments: [],
        tools: [],
        approvals: true,
        userInput: true,
        worktrees: "optional",
        resources: [],
        interactionModes: ["default"],
        permissionModes: ["supervised"],
        ...supports,
      },
    }],
  });
}

type FakeState = { sessionId: string };

function adapter(
  start: NonNullable<CanonicalChatProviderAdapter<FakeState>["start"]>,
  extra: Partial<CanonicalChatProviderAdapter<FakeState>> = {},
): CanonicalChatProviderAdapter<FakeState> {
  return {
    driverKind: "codex",
    stateSchemaVersion: 1,
    parseState(value) {
      const sessionId = (value as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== "string") throw new Error("invalid state");
      return { sessionId };
    },
    serializeState: (value) => value,
    start,
    ...extra,
  };
}

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

describe("normalized argument digest", () => {
  it("is stable across key ordering and detects mutations", () => {
    const reordered = normalizedArgumentDigest({ subject: "launch", to: "owner@example.com", op: "send_email" });
    expect(reordered).toBe(proposedDigest);
    expect(differentDigest).not.toBe(proposedDigest);
    expect(canonicalJsonStringify({ b: [2, { d: 1, c: 3 }], a: 1 }))
      .toBe(canonicalJsonStringify({ a: 1, b: [2, { c: 3, d: 1 }] }));
    expect(normalizedArgumentDigest(proposedArgs)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("truthful cancellation granularity", () => {
  it("maps the legacy boolean and fails closed for undeclared hooks", () => {
    expect(truthfulCancellationGranularity(true, {})).toBe("run");
    expect(truthfulCancellationGranularity(false, {})).toBe("none");
    expect(truthfulCancellationGranularity(undefined, {})).toBe("none");
    expect(truthfulCancellationGranularity("run", {})).toBe("run");
    expect(truthfulCancellationGranularity("none", {})).toBe("none");
  });

  it("degrades a tool claim to run when the adapter lacks a tool cancel hook", () => {
    expect(truthfulCancellationGranularity("tool", { cancelTool: async () => {} })).toBe("tool");
    expect(truthfulCancellationGranularity("tool", {})).toBe("run");
  });

  it("degrades to none for detached adapters with no provider cancel hook", () => {
    expect(truthfulCancellationGranularity("run", { detachOnShutdown: true })).toBe("none");
    expect(truthfulCancellationGranularity("run", { detachOnShutdown: true, cancel: async () => {} }))
      .toBe("run");
    expect(truthfulCancellationGranularity("tool", { detachOnShutdown: true, cancel: async () => {} }))
      .toBe("run");
  });
});

describe("argument-digest-bound approvals", () => {
  async function admitWithPendingApproval(catalogOverride: Record<string, unknown>, digest?: string) {
    await repository.create(owner, {
      id: "chat_action",
      clientRequestId: "req_create_action",
      title: "Action",
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const submitApproval = vi.fn(async () => { release(); });
    const provider = adapter(async function* () {
      yield { type: "state.updated" as const, state: { sessionId: "native_action" } };
      yield {
        type: "approval.requested" as const,
        approvalId: "appr_send",
        title: "Send email",
        risk: "high" as const,
        ...(digest ? { argumentDigest: digest } : {}),
        allowedDecisions: ["approve" as const, "decline" as const],
      };
      await released;
      yield { type: "run.completed" as const, outcome: "completed" as const };
    }, { submitApproval });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog(catalogOverride) },
      adapters: new CanonicalChatProviderRegistry([provider]),
    });
    const admitted = await orchestrator.admitTurn(principal, owner, "chat_action", {
      clientRequestId: "req_action_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "send it" }],
      selection,
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await vi.waitFor(async () => {
      const pending = await repository.getPendingApproval(owner, {
        chatId: "chat_action", runId: admitted.run.id, approvalId: "appr_send",
      });
      expect(pending?.approvalId).toBe("appr_send");
    });
    return { orchestrator, admitted, submitApproval, release };
  }

  it("rejects a decision when the approved digest differs from the proposal", async () => {
    const { orchestrator, admitted, submitApproval, release } = await admitWithPendingApproval(
      { approvalBinding: "argument_digest" },
      proposedDigest,
    );
    try {
      await expect(orchestrator.submitApproval(owner, "chat_action", admitted.run.id, "appr_send", {
        clientRequestId: "req_decision_mismatch",
        decision: "approve",
        argumentDigest: differentDigest,
      })).rejects.toMatchObject({ status: 409, safeError: { code: "capability_mismatch" } });
      expect(submitApproval).not.toHaveBeenCalled();
    } finally {
      release();
      await orchestrator.close();
    }
  });

  it("rejects a bound approval submitted without the digest", async () => {
    const { orchestrator, admitted, submitApproval, release } = await admitWithPendingApproval(
      { approvalBinding: "argument_digest" },
      proposedDigest,
    );
    try {
      await expect(orchestrator.submitApproval(owner, "chat_action", admitted.run.id, "appr_send", {
        clientRequestId: "req_decision_missing",
        decision: "approve",
      })).rejects.toMatchObject({ status: 409 });
      expect(submitApproval).not.toHaveBeenCalled();
    } finally {
      release();
      await orchestrator.close();
    }
  });

  it("fails closed when the bound proposal carried no digest", async () => {
    const { orchestrator, admitted, submitApproval, release } = await admitWithPendingApproval(
      { approvalBinding: "argument_digest" },
    );
    try {
      await expect(orchestrator.submitApproval(owner, "chat_action", admitted.run.id, "appr_send", {
        clientRequestId: "req_decision_unbound",
        decision: "approve",
        argumentDigest: proposedDigest,
      })).rejects.toMatchObject({ status: 409 });
      expect(submitApproval).not.toHaveBeenCalled();
    } finally {
      release();
      await orchestrator.close();
    }
  });

  it("forwards the matching digest to the provider hook", async () => {
    const { orchestrator, admitted, submitApproval, release } = await admitWithPendingApproval(
      { approvalBinding: "argument_digest" },
      proposedDigest,
    );
    try {
      const result = await orchestrator.submitApproval(owner, "chat_action", admitted.run.id, "appr_send", {
        clientRequestId: "req_decision_match",
        decision: "approve",
        argumentDigest: proposedDigest,
      });
      expect(result).toMatchObject({ approvalId: "appr_send", submission: "accepted" });
      expect(submitApproval).toHaveBeenCalledWith(expect.objectContaining({
        approvalId: "appr_send",
        argumentDigest: proposedDigest,
      }));
    } finally {
      release();
      await orchestrator.close();
    }
  });

  it("does not require a digest when the snapshot binds none", async () => {
    const { orchestrator, admitted, submitApproval, release } = await admitWithPendingApproval(
      {},
      proposedDigest,
    );
    try {
      const result = await orchestrator.submitApproval(owner, "chat_action", admitted.run.id, "appr_send", {
        clientRequestId: "req_decision_unbound_ok",
        decision: "approve",
      });
      expect(result.submission).toBe("accepted");
      expect(submitApproval).toHaveBeenCalled();
    } finally {
      release();
      await orchestrator.close();
    }
  });
});

describe("capability snapshot truthfulness", () => {
  it("records the declared cancellation granularity on the run snapshot", async () => {
    await repository.create(owner, {
      id: "chat_cap",
      clientRequestId: "req_create_cap",
      title: "Capability",
    });
    const provider = adapter(async function* () {
      yield { type: "run.completed" as const, outcome: "completed" as const };
    }, { cancelTool: async () => {} });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog({ cancellation: "tool" }) },
      adapters: new CanonicalChatProviderRegistry([provider]),
    });
    try {
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_cap", {
        clientRequestId: "req_cap_turn",
        baseRevision: 0,
        parts: [{ type: "text", text: "hi" }],
        selection,
        interactionMode: "default",
        permissionMode: "supervised",
      });
      expect(admitted.run.capabilitySnapshot.cancellation).toBe("tool");
      expect(admitted.run.capabilitySnapshot.approvalBinding).toBeUndefined();
    } finally {
      await orchestrator.close();
    }
  });

  it("degrades a tool claim to run granularity when the adapter cannot cancel tools", async () => {
    await repository.create(owner, {
      id: "chat_cap_degraded",
      clientRequestId: "req_create_cap_degraded",
      title: "Capability",
    });
    const provider = adapter(async function* () {
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog({ cancellation: "tool" }) },
      adapters: new CanonicalChatProviderRegistry([provider]),
    });
    try {
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_cap_degraded", {
        clientRequestId: "req_cap_turn_degraded",
        baseRevision: 0,
        parts: [{ type: "text", text: "hi" }],
        selection,
        interactionMode: "default",
        permissionMode: "supervised",
      });
      expect(admitted.run.capabilitySnapshot.cancellation).toBe("run");
    } finally {
      await orchestrator.close();
    }
  });
});

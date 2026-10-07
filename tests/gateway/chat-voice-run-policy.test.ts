import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import {
  CANONICAL_VOICE_CONVERSATION_ONLY_POLICY,
  CanonicalChatRunPolicySchema,
  CanonicalProviderCatalogSchema,
  type CanonicalChatRunPolicy,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { sql } from "kysely";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import {
  CanonicalChatProviderRegistry,
  type CanonicalChatProviderAdapter,
} from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import {
  loadChatResumeDecision,
  loadChatResumeState,
} from "../../packages/gateway/src/chat/resume-checkpoint.js";

const owner = { type: "personal" as const, ownerId: "owner_voice_policy" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const selection = { instanceId: "codex_default", model: "gpt-5.6-sol" };

const sessionOnlyPolicy = {
  memoryMode: "session_only",
  nativeCheckpointPolicy: "disposable",
  source: "voice",
  voiceSessionId: "vsession_policy",
} as const satisfies CanonicalChatRunPolicy;

/**
 * Session-only memory is unsupported at admission (`sessionOnly:
 * "unsupported"`): `revalidateActionPolicy` rejects it outright, so a live
 * session always stamps the ordinary mode plus the pinned conversation-only
 * execution policy — the only frozen policy admissible without an adapter
 * `qualifyPolicy` echo.
 */
const sessionPolicy = {
  sessionId: "vsession_policy",
  memoryMode: "ordinary",
  permissionMode: "supervised",
  executionPolicy: CANONICAL_VOICE_CONVERSATION_ONLY_POLICY,
} as const;

/** What a caller supplies: the session overrides authority fields anyway. */
function requestPolicy(source: "voice" | "typed" = "voice"): CanonicalChatRunPolicy {
  return { memoryMode: "ordinary", nativeCheckpointPolicy: "reusable", source };
}

function voiceSessionPolicy() {
  return { policyForChat: () => sessionPolicy };
}

function catalog(): CanonicalProviderCatalog {
  return CanonicalProviderCatalogSchema.parse({
    revision: "catalog_voice_policy",
    drivers: [{
      kind: "codex",
      displayName: "Codex",
      adapterVersion: "1.0.0",
      capabilityClass: "system_agent",
    }],
    instances: [{
      id: "codex_default",
      driverKind: "codex",
      displayName: "Codex",
      availability: "available",
      workspaceRequirement: "project_optional",
      catalogRevision: "catalog_voice_policy",
      models: [{
        id: selection.model,
        displayName: "GPT-5.6-Sol",
        availability: "available",
        capabilities: [],
        supportsVision: false,
        supportsToolUse: false,
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
    resume: start,
    ...extra,
  };
}

function completing(sessionId: string): CanonicalChatProviderAdapter<FakeState>["start"] {
  return async function* () {
    yield { type: "state.updated" as const, state: { sessionId } };
    yield { type: "run.completed" as const, outcome: "completed" as const };
  };
}

/** Holds the run mid-stream until released; keeps chat revision stable. */
function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const start: CanonicalChatProviderAdapter<FakeState>["start"] = async function* () {
    yield { type: "state.updated" as const, state: { sessionId: "native_gated" } };
    await gate;
    yield { type: "run.completed" as const, outcome: "completed" as const };
  };
  return { start, release };
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

async function createChat(id = "chat_voice") {
  return repository.create(owner, { id, clientRequestId: `req_create_${id}`, title: "Voice" });
}

function turnRequest(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: "req_voice_turn_1",
    baseRevision: 0,
    parts: [{ type: "text" as const, text: "send it" }],
    selection,
    interactionMode: "default",
    permissionMode: "supervised",
    ...overrides,
  };
}

async function currentRevision(chatId = "chat_voice") {
  const record = await repository.get(owner, chatId);
  if (!record) throw new Error("chat missing");
  return record.chat.revision;
}

async function waitForRunStatus(runId: string, statuses: readonly string[]) {
  await expect.poll(async () => {
    const row = await repository.kysely.selectFrom("chat_runs").select("status")
      .where("id", "=", runId).executeTakeFirst();
    return row?.status ?? null;
  }, { timeout: 5_000, interval: 20 }).toSatisfy((status) => status !== null && statuses.includes(status));
}

describe("voice run policy admission", () => {
  it("persists the immutable policy snapshot on the admitted run", async () => {
    await createChat();
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(completing("native_voice_1"))]),
      voiceSessionPolicy: voiceSessionPolicy(),
    });
    try {
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        runPolicy: requestPolicy("voice"),
      }));
      expect(admitted.admission).toBe("accepted");
      expect(admitted.run.runPolicy).toMatchObject({
        memoryMode: "ordinary",
        source: "voice",
        voiceSessionId: "vsession_policy",
        executionPolicy: CANONICAL_VOICE_CONVERSATION_ONLY_POLICY,
      });
      const stored = await repository.kysely.selectFrom("chat_runs").selectAll()
        .where("id", "=", admitted.run.id).executeTakeFirstOrThrow();
      expect(CanonicalChatRunPolicySchema.parse(stored.run_policy)).toMatchObject({
        memoryMode: "ordinary",
        nativeCheckpointPolicy: "reusable",
      });
    } finally {
      await orchestrator.close();
    }
  });

  it("rejects session-only run policies at admission: session_only is unsupported", async () => {
    await createChat();
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(completing("native_voice_session_only"))]),
    });
    try {
      await expect(orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        runPolicy: sessionOnlyPolicy,
      }))).rejects.toMatchObject({ status: 400 });
    } finally {
      await orchestrator.close();
    }
  });

  it("replays admission only for an identical policy; a different policy conflicts", async () => {
    await createChat();
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(completing("native_voice_2"))]),
      voiceSessionPolicy: voiceSessionPolicy(),
    });
    try {
      const first = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        runPolicy: requestPolicy("voice"),
      }));
      const replay = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        runPolicy: requestPolicy("voice"),
      }));
      expect(replay.admission).toBe("already_accepted");
      expect(replay.run.id).toBe(first.run.id);
      await expect(orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        runPolicy: requestPolicy("typed"),
      }))).rejects.toMatchObject({ status: 409 });
      // A policy-bearing request must not dedup into a policy-less admission either.
      await waitForRunStatus(first.run.id, ["completed", "failed", "aborted"]);
      const flip = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_policy_flip",
        baseRevision: await currentRevision(),
        runPolicy: requestPolicy("voice"),
      }));
      expect(flip.admission).toBe("accepted");
      await expect(orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_policy_flip",
        baseRevision: await currentRevision(),
      }))).rejects.toMatchObject({ status: 409 });
    } finally {
      await orchestrator.close();
    }
  });
});

describe("voice run policy through queue and steering", () => {
  it("admits typed and voice finals through the same canonical ordering", async () => {
    await createChat();
    const { start, release } = gated();
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(start)]),
      voiceSessionPolicy: voiceSessionPolicy(),
    });
    try {
      const spoken = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_spoken",
        runPolicy: requestPolicy("voice"),
      }));
      expect(spoken.run.runPolicy?.source).toBe("voice");
      await waitForRunStatus(spoken.run.id, ["running", "waiting_for_approval", "waiting_for_input"]);
      // A typed final while the voice run is active joins the same canonical queue.
      const typed = await orchestrator.enqueueQueuedTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_typed_while_voice",
        parts: [{ type: "text", text: "typed while the session owns the chat" }],
        runPolicy: requestPolicy("typed"),
      }));
      expect(typed.queuedTurn.runPolicy).toMatchObject({ memoryMode: "ordinary", source: "typed" });
      release();
      await expect.poll(async () => {
        const row = await repository.kysely.selectFrom("chat_queued_turns")
          .select(["status", "claimed_run_id"]).where("id", "=", typed.queuedTurn.id).executeTakeFirst();
        return row?.status === "claimed" ? row.claimed_run_id : null;
      }, { timeout: 5_000, interval: 25 }).not.toBeNull();
      const claimedRow = await repository.kysely.selectFrom("chat_queued_turns")
        .select("claimed_run_id").where("id", "=", typed.queuedTurn.id).executeTakeFirstOrThrow();
      const claimedRun = await repository.kysely.selectFrom("chat_runs").selectAll()
        .where("id", "=", claimedRow.claimed_run_id!).executeTakeFirstOrThrow();
      expect(CanonicalChatRunPolicySchema.parse(claimedRun.run_policy)).toMatchObject({
        memoryMode: "ordinary",
        source: "typed",
      });
      const claimedTurn = await repository.kysely.selectFrom("chat_turns").selectAll()
        .where("id", "=", claimedRun.turn_id).executeTakeFirstOrThrow();
      expect(Number(claimedTurn.base_message_seq)).toBeGreaterThan(spoken.turn.baseMessageSeq);
    } finally {
      release();
      await orchestrator.close();
    }
  });

  it("carries the policy through enqueue and promotion into the claimed run", async () => {
    await createChat();
    const { start, release } = gated();
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(start)]),
      voiceSessionPolicy: voiceSessionPolicy(),
    });
    try {
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_active_run",
      }));
      // A live session owns this Chat: even a policy-less request is stamped.
      expect(admitted.run.runPolicy).toMatchObject({ memoryMode: "ordinary" });
      await waitForRunStatus(admitted.run.id, ["running", "waiting_for_approval", "waiting_for_input"]);
      const queued = await orchestrator.enqueueQueuedTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_queued_voice",
        runPolicy: requestPolicy("voice"),
      }));
      expect(queued.queuedTurn.runPolicy).toMatchObject({ memoryMode: "ordinary" });
      const storedQueued = await repository.kysely.selectFrom("chat_queued_turns").selectAll()
        .where("id", "=", queued.queuedTurn.id).executeTakeFirstOrThrow();
      expect(CanonicalChatRunPolicySchema.parse(storedQueued.run_policy)).toMatchObject({
        memoryMode: "ordinary",
        executionPolicy: CANONICAL_VOICE_CONVERSATION_ONLY_POLICY,
      });
      release();
      await expect.poll(async () => {
        const row = await repository.kysely.selectFrom("chat_queued_turns")
          .select("status").where("id", "=", queued.queuedTurn.id).executeTakeFirst();
        return row?.status;
      }, { timeout: 5_000, interval: 25 }).toBe("claimed");
      const claimedTurnId = (await repository.kysely.selectFrom("chat_queued_turns")
        .select("claimed_turn_id").where("id", "=", queued.queuedTurn.id)
        .executeTakeFirstOrThrow()).claimed_turn_id!;
      const claimedRun = await repository.kysely.selectFrom("chat_runs").selectAll()
        .where("turn_id", "=", claimedTurnId).executeTakeFirstOrThrow();
      expect(CanonicalChatRunPolicySchema.parse(claimedRun.run_policy)).toMatchObject({
        memoryMode: "ordinary",
        source: "voice",
      });
    } finally {
      release();
      await orchestrator.close();
    }
  });

  it("rejects session-only queued turns outright: session_only is unsupported", async () => {
    await createChat();
    const { start, release } = gated();
    const provider = adapter(start, { steer: async () => {} });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
    });
    try {
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_active_steer",
      }));
      await waitForRunStatus(admitted.run.id, ["running", "waiting_for_approval", "waiting_for_input"]);
      await expect(orchestrator.enqueueQueuedTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_queued_steer",
        runPolicy: sessionOnlyPolicy,
      }))).rejects.toMatchObject({ status: 400 });
      const queuedRows = await repository.kysely.selectFrom("chat_queued_turns").selectAll()
        .where("chat_id", "=", "chat_voice").execute();
      expect(queuedRows).toHaveLength(0);
    } finally {
      release();
      await orchestrator.close();
    }
  });

  it("steers a queued turn whose policy matches the active run", async () => {
    await createChat();
    const { start, release } = gated();
    const provider = adapter(start, { steer: async () => {} });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      voiceSessionPolicy: voiceSessionPolicy(),
    });
    try {
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_active_steer_match",
        runPolicy: requestPolicy("voice"),
      }));
      await waitForRunStatus(admitted.run.id, ["running", "waiting_for_approval", "waiting_for_input"]);
      const queued = await orchestrator.enqueueQueuedTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_queued_steer_match",
        runPolicy: requestPolicy("typed"),
      }));
      const steered = await orchestrator.steerQueuedTurn(owner, "chat_voice", admitted.run.id,
        queued.queuedTurn.id, {
          clientRequestId: "req_steer_voice_match",
          baseRevision: await currentRevision(),
          expectedTurnId: admitted.turn.id,
        });
      expect(steered.steering).toBe("accepted");
      const steerRow = await repository.kysely.selectFrom("chat_run_steers").selectAll()
        .where("queued_turn_id", "=", queued.queuedTurn.id).executeTakeFirstOrThrow();
      expect(steerRow.status).toBe("accepted");
      const queuedRow = await repository.kysely.selectFrom("chat_queued_turns")
        .select(["status", "run_policy"]).where("id", "=", queued.queuedTurn.id)
        .executeTakeFirstOrThrow();
      expect(queuedRow.status).toBe("claimed");
      expect(CanonicalChatRunPolicySchema.parse(queuedRow.run_policy)).toMatchObject({
        memoryMode: "ordinary",
        executionPolicy: CANONICAL_VOICE_CONVERSATION_ONLY_POLICY,
      });
    } finally {
      release();
      await orchestrator.close();
    }
  });
});

async function completedCheckpoint(suffix: string, policy?: CanonicalChatRunPolicy) {
    const record = (await repository.get(owner, "chat_voice"))!.chat;
    const seq = record.messageCount + 1;
    const timestamp = new Date(Date.UTC(2026, 8, 9, 0, 0, seq)).toISOString();
    const message = {
      id: `msg_cp_${suffix}`, chatId: "chat_voice", seq, role: "user" as const,
      state: "committed" as const, turnId: `cturn_cp_${suffix}`,
      parts: [{ type: "text" as const, text: "remember" }], createdAt: timestamp,
    };
    const turn = {
      id: message.turnId, chatId: "chat_voice", clientRequestId: `req_cp_${suffix}`,
      baseMessageSeq: seq - 1, inputMessageId: message.id, status: "accepted" as const,
      createdAt: timestamp, updatedAt: timestamp,
    };
    const run = {
      id: `run_cp_${suffix}`, chatId: "chat_voice", turnId: turn.id, attempt: 1,
      driverKind: "codex" as const, instanceId: "codex_default", selection,
      interactionMode: "default", permissionMode: "supervised", status: "accepted" as const,
      historyBoundarySeq: seq - 1,
      ...(policy ? { runPolicy: policy } : {}),
      capabilitySnapshot: {
        revision: "catalog_voice_policy", rootChat: true, attachments: [], resources: [],
        tools: [], approvals: true, userInput: true, resume: true, cancellation: true,
        steering: "none" as const, worktrees: "optional" as const,
        interactionModes: ["default"], permissionModes: ["supervised"],
      },
      createdAt: timestamp, updatedAt: timestamp,
    };
    await repository.admitTurn(owner, {
      chatId: "chat_voice", baseRevision: record.revision, message, turn,
      run: run as never,
      adapterState: { schemaVersion: 1, state: { sessionId: `native_cp_${suffix}` } },
    });
    await repository.finishRun(owner, {
      chatId: "chat_voice", runId: run.id, outcome: "completed", completedAt: timestamp,
    });
    return run.id;
  }

function checkpointQuery(options: Parameters<ChatRepository["getLatestAdapterStateForChat"]>[1]) {
  return repository.getLatestAdapterStateForChat(owner, {
    chatId: "chat_voice",
    driverKind: "codex",
    instanceId: "codex_default",
    schemaVersion: 1,
    executionRootFingerprint: null,
    ...options,
  });
}

describe("voice resume checkpoint eligibility", () => {
  it("reuses a reusable checkpoint for ordinary follow-ups", async () => {
    await createChat();
    await completedCheckpoint("a");
    const state = await checkpointQuery({});
    expect(state?.state).toMatchObject({ sessionId: "native_cp_a" });
  });

  it("never reuses a checkpoint produced under session-only policy", async () => {
    await createChat();
    await completedCheckpoint("session", sessionOnlyPolicy);
    const state = await checkpointQuery({});
    expect(state).toBeNull();
  });

  it("session-only callers force a disposable path: no native reuse at all", async () => {
    await createChat();
    await completedCheckpoint("ordinary");
    const state = await checkpointQuery({ sessionOnly: true });
    expect(state).toBeNull();
  });

  it("unheard responses invalidate the producing run's checkpoint", async () => {
    await createChat();
    const unheardRun = await completedCheckpoint("unheard");
    const older = await completedCheckpoint("heard");
    // The newest checkpoint is from an unheard response; the older heard one wins.
    const state = await checkpointQuery({ unheardResponses: [unheardRun] });
    expect(state?.state).toMatchObject({ sessionId: "native_cp_heard" });
    expect(older).toBeDefined();
    const allUnheard = await checkpointQuery({ unheardResponses: [unheardRun, older] });
    expect(allUnheard).toBeNull();
  });

  it("unheard assistant message ids also invalidate the producing checkpoint", async () => {
    await createChat();
    const runId = await completedCheckpoint("message_level");
    await repository.kysely.insertInto("chat_messages").values({
      id: "msg_assistant_unheard",
      chat_id: "chat_voice",
      seq: 99,
      role: "assistant",
      state: "committed",
      turn_id: null,
      run_id: runId,
      parts: sql`${JSON.stringify([{ type: "text", text: "unheard reply" }])}` as never,
      byte_count: 64,
      search_text: "unheard reply",
      created_at: new Date().toISOString(),
    }).execute();
    const state = await checkpointQuery({ unheardResponses: ["msg_assistant_unheard"] });
    expect(state).toBeNull();
  });

  it("loadChatResumeState fails closed for session-only policy and unheard deliveries", async () => {
    await createChat();
    await completedCheckpoint("eligible");
    const fake = adapter(completing("native_unused"));
    const sessionOnly = await loadChatResumeState({
      repository, owner, chatId: "chat_voice", instanceId: "codex_default",
      adapter: fake, executionRootFingerprint: null, mode: "follow_up",
      runPolicy: sessionOnlyPolicy,
    });
    expect(sessionOnly).toBeUndefined();
    const ordinary = await loadChatResumeState({
      repository, owner, chatId: "chat_voice", instanceId: "codex_default",
      adapter: fake, executionRootFingerprint: null, mode: "follow_up",
    });
    expect(ordinary).toMatchObject({ sessionId: "native_cp_eligible" });
  });

  it("excludes checkpoints bound to unresolved deliveries without caller hints", async () => {
    await createChat();
    const heardRun = await completedCheckpoint("durable_heard");
    const unheardRun = await completedCheckpoint("durable_unheard");
    // A durable non-complete delivery row bound to the newest run excludes it
    // database-side — no caller-supplied unheardResponses list required.
    await repository.kysely.insertInto("chat_voice_deliveries").values({
      chat_id: "chat_voice",
      response_id: "resp_durable_unheard",
      run_id: unheardRun,
      message_id: "msg_durable_unheard",
      state: "interrupted",
      revision: 1,
      segments: sql`${JSON.stringify([
        { segmentId: "seg_1", textStart: 0, textEnd: 12, durationMs: 100 },
      ])}` as never,
      acknowledged_segment: null,
      delivered_through_ms: 0,
      played_through_ms: 0,
      effective_text_end: 0,
      transport_epoch: 1,
      terminal_reason: "interrupted",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).execute();
    // The newest checkpoint is delivery-ineligible, so the older heard run
    // wins — durable NOT EXISTS semantics, no caller hints involved.
    const state = await checkpointQuery({});
    expect(state?.state).toMatchObject({ sessionId: "native_cp_durable_heard" });
    expect(state?.checkpoint?.runId).toBe(heardRun);
    expect(state?.checkpoint?.runId).not.toBe(unheardRun);
  });

});

describe("checkpoint provenance and retained history", () => {
  const fake = adapter(completing("native_unused"));

  async function commitMessage(id: string, seq: number, text: string, runId?: string) {
    await repository.kysely.insertInto("chat_messages").values({
      id,
      chat_id: "chat_voice",
      seq,
      role: runId ? "assistant" : "user",
      state: "committed",
      turn_id: null,
      run_id: runId ?? null,
      actor_id: null,
      purpose: "ai_request",
      parts: sql`${JSON.stringify([{ type: "text", text }])}` as never,
      byte_count: Buffer.byteLength(text),
      search_text: text,
      created_at: new Date().toISOString(),
    }).execute();
  }

  async function insertDelivery(input: {
    responseId: string; runId: string; messageId: string;
    state: "pending" | "playing" | "complete" | "interrupted" | "unknown";
    effectiveTextEnd?: number;
  }) {
    await repository.kysely.insertInto("chat_voice_deliveries").values({
      chat_id: "chat_voice",
      response_id: input.responseId,
      run_id: input.runId,
      message_id: input.messageId,
      state: input.state,
      revision: 1,
      segments: sql`${JSON.stringify([
        { segmentId: "seg_1", textStart: 0, textEnd: 12, durationMs: 100 },
      ])}` as never,
      acknowledged_segment: null,
      delivered_through_ms: 0,
      played_through_ms: 0,
      effective_text_end: input.effectiveTextEnd ?? 0,
      transport_epoch: 1,
      terminal_reason: input.state === "complete" ? null : "interrupted",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).execute();
  }

  function decision(overrides: Record<string, unknown> = {}) {
    return loadChatResumeDecision({
      repository, owner, chatId: "chat_voice", instanceId: "codex_default",
      adapter: fake, executionRootFingerprint: null, mode: "follow_up",
      ...overrides,
    });
  }

  it("rebuilds from a heard-safe projection when an interrupted first response leaves no eligible checkpoint", async () => {
    await createChat();
    const interruptedRun = await completedCheckpoint("first_interrupted");
    await commitMessage("msg_first_response", 2, "this was never heard", interruptedRun);
    await insertDelivery({
      responseId: "resp_first_interrupted",
      runId: interruptedRun,
      messageId: "msg_first_response",
      state: "interrupted",
      effectiveTextEnd: 0,
    });

    const result = await decision({ retainedHistorySupported: true, historyBoundarySeq: 2 });

    expect(result.mode).toBe("rebuild");
    expect(result.reason).toBe("no_checkpoint");
    expect(result.resumeState).toBeUndefined();
    expect(result.retainedHistory?.text).toContain("remember");
    expect(result.retainedHistory?.text).not.toContain("this was never heard");
  });

  it("rebuilds heard-safe history for disposable session-only follow-ups", async () => {
    await createChat();
    await completedCheckpoint("before_disposable");

    const result = await decision({
      retainedHistorySupported: true,
      historyBoundarySeq: 1,
      runPolicy: sessionOnlyPolicy,
    });

    expect(result).toMatchObject({
      mode: "rebuild",
      reason: "disposable_policy",
    });
    expect(result.resumeState).toBeUndefined();
    expect(result.retainedHistory?.text).toContain("remember");
  });

  it("reports provenance for a checkpoint that covers committed history", async () => {
    await createChat();
    const runId = await completedCheckpoint("covered");
    const result = await decision({ retainedHistorySupported: true, historyBoundarySeq: 1 });
    expect(result.mode).toBe("resume");
    expect(result.resumeState).toMatchObject({ sessionId: "native_cp_covered" });
    expect(result.checkpoint).toMatchObject({
      runId,
      historyBoundarySeq: 0,
      coveredThroughSeq: 1,
    });
    expect(result.retainedHistory).toBeUndefined();
  });

  it.each(["voice", "typed"] as const)("rebuilds %s canonical-action turns instead of resuming a single-use runner", async (source) => {
    await createChat();
    await completedCheckpoint("single_use");
    await commitMessage("msg_heard", 2, "7 plus 11 is 18.", "run_heard");
    const result = await decision({
      retainedHistorySupported: true,
      historyBoundarySeq: 2,
      runPolicy: { ...requestPolicy(source), executionPolicy: {
        revision: "codex_canonical_v1", actionMode: "canonical_actions", workspaceScope: "apps",
        tools: ["matrix_list_apps"], delegation: false,
      } },
    });
    expect(result.mode).toBe("rebuild");
    expect(result.resumeState).toBeUndefined();
    expect(result.retainedHistory?.text).toContain("remember");
    expect(result.retainedHistory?.text).toContain("7 plus 11 is 18.");
  });

  it("resumes with retained canonical history when the checkpoint predates it", async () => {
    await createChat();
    const runId = await completedCheckpoint("retained");
    await commitMessage("msg_gap_user", 2, "typed after the checkpoint");
    const result = await decision({ retainedHistorySupported: true, historyBoundarySeq: 2 });
    expect(result.mode).toBe("resume_retained");
    expect(result.resumeState).toMatchObject({ sessionId: "native_cp_retained" });
    expect(result.checkpoint?.runId).toBe(runId);
    expect(result.checkpoint?.coveredThroughSeq).toBe(1);
    // The retained slice is the heard-safe gap — the committed message the
    // native session cannot contain.
    expect(result.retainedHistory?.throughSeq).toBe(2);
    expect(result.retainedHistory?.text).toContain("typed after the checkpoint");
  });

  it("trims unheard suffixes out of retained history", async () => {
    await createChat();
    await completedCheckpoint("heard_trim");
    await commitMessage("msg_gap_unheard", 2, "played and then some", "run_gap_src");
    await insertDelivery({
      responseId: "resp_trim", runId: "run_gap_src", messageId: "msg_gap_unheard",
      state: "interrupted", effectiveTextEnd: 6,
    });
    const result = await decision({ retainedHistorySupported: true, historyBoundarySeq: 2 });
    expect(result.mode).toBe("resume_retained");
    expect(result.retainedHistory?.text).toContain("played");
    expect(result.retainedHistory?.text).not.toContain("then some");
  });

  it("declines native resume when the caller cannot retain canonical history", async () => {
    await createChat();
    await completedCheckpoint("unsupported");
    await commitMessage("msg_gap_no_retain", 2, "cannot be dropped");
    const result = await decision({ historyBoundarySeq: 2 });
    expect(result.mode).toBe("rebuild");
    expect(result.reason).toBe("retention_unsupported");
    expect(result.resumeState).toBeUndefined();
    expect(result.checkpoint?.coveredThroughSeq).toBe(1);
    // The rebuild decision still carries heard-safe canonical history.
    expect(result.retainedHistory?.text).toContain("remember");
  });

  it("declines native resume when the retained gap exceeds the bounded window", async () => {
    await createChat();
    await completedCheckpoint("truncated");
    await commitMessage("msg_gap_huge", 2, `x`.repeat(14_000));
    const result = await decision({ retainedHistorySupported: true, historyBoundarySeq: 2 });
    expect(result.mode).toBe("rebuild");
    expect(result.reason).toBe("retention_truncated");
    expect(result.resumeState).toBeUndefined();
  });

  it("fails closed when checkpoint eligibility evaluation throws", async () => {
    await createChat();
    await completedCheckpoint("eligibility");
    const failing = {
      getLatestAdapterStateForChat: async () => {
        throw new Error("eligibility store unavailable");
      },
      kysely: repository.kysely,
    };
    const result = await loadChatResumeDecision({
      repository: failing, owner, chatId: "chat_voice", instanceId: "codex_default",
      adapter: fake, executionRootFingerprint: null, mode: "follow_up",
      retainedHistorySupported: true, historyBoundarySeq: 1,
    });
    expect(result.mode).toBe("rebuild");
    expect(result.reason).toBe("eligibility_unavailable");
    expect(result.resumeState).toBeUndefined();
    // Native resume is disabled — the run rebuilds from canonical history.
    expect(result.retainedHistory?.text).toContain("remember");
  });

  it("legacy loadChatResumeState never rewinds past a committed-history gap", async () => {
    await createChat();
    await completedCheckpoint("legacy_gap");
    await commitMessage("msg_gap_legacy", 2, "must not be dropped silently");
    // The wrapper cannot express retained history, so any real gap disables
    // native resume entirely rather than silently rewinding canonical history.
    const state = await loadChatResumeState({
      repository, owner, chatId: "chat_voice", instanceId: "codex_default",
      adapter: fake, executionRootFingerprint: null, mode: "follow_up",
    });
    expect(state).toBeUndefined();
  });
});

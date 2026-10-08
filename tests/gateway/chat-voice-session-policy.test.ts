/**
 * Live voice-session policy enforcement at canonical admission
 * (specs/535-aoede-rewrite, FR-037): while a session owns a Chat, its frozen
 * memory/checkpoint/permission policy is stamped onto chat_runs and
 * chat_queued_turns for spoken and typed turns alike — never bypassable by a
 * request-supplied policy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import {
  CanonicalChatRunPolicySchema,
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import {
  CanonicalChatProviderRegistry,
  type CanonicalChatProviderAdapter,
} from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import {
  admissionPolicyForTurn,
  createVoiceSessionPolicyLookup,
} from "../../packages/gateway/src/chat/voice-session-policy.js";

const owner = { type: "personal" as const, ownerId: "owner_session_policy" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const selection = { instanceId: "codex_default", model: "gpt-5.6-sol" };

const liveSession = {
  sessionId: "vsession_live",
  memoryMode: "ordinary" as const,
  permissionMode: "supervised",
  executionPolicy: { revision: "actions_v1", actionMode: "safe_reads" as const, workspaceScope: "apps", tools: ["matrix_list_apps"], delegation: false },
};

function catalog(): CanonicalProviderCatalog {
  return CanonicalProviderCatalogSchema.parse({
    revision: "catalog_session_policy",
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
      catalogRevision: "catalog_session_policy",
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

function toolCapableCatalog(): CanonicalProviderCatalog {
  const value = catalog();
  value.drivers[0]!.capabilityClass = "coding_agent";
  value.instances[0]!.models[0]!.capabilities = ["tools"];
  value.instances[0]!.models[0]!.supportsToolUse = true;
  return value;
}

function completing(sessionId: string): CanonicalChatProviderAdapter["start"] {
  return async function* () {
    yield { type: "state.updated" as const, state: { sessionId } };
    yield { type: "run.completed" as const, outcome: "completed" as const };
  };
}

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const start: CanonicalChatProviderAdapter["start"] = async function* () {
    yield { type: "state.updated" as const, state: { sessionId: "native_gated" } };
    await gate;
    yield { type: "run.completed" as const, outcome: "completed" as const };
  };
  return { start, release };
}

function adapter(start: CanonicalChatProviderAdapter["start"]): CanonicalChatProviderAdapter {
  return {
    driverKind: "codex",
    stateSchemaVersion: 1,
    qualifyPolicy: async () => liveSession.executionPolicy,
    parseState: (value) => value,
    serializeState: (value) => value,
    start,
  };
}

let pglite: InstanceType<typeof KyselyPGlite>;
let repository: ChatRepository;

beforeEach(async () => {
  pglite = await KyselyPGlite.create();
  repository = new ChatRepository(pglite.dialect);
  await repository.bootstrap();
  await repository.create(owner, {
    id: "chat_voice", clientRequestId: "req_create_session_policy", title: "Session policy",
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await repository.kysely.destroy();
});

function turnRequest(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: "req_session_turn",
    baseRevision: 0,
    parts: [{ type: "text" as const, text: "send it" }],
    selection,
    interactionMode: "default",
    permissionMode: "supervised",
    ...overrides,
  };
}

async function currentRevision() {
  const record = await repository.get(owner, "chat_voice");
  if (!record) throw new Error("chat missing");
  return record.chat.revision;
}

async function waitForActive(runId: string) {
  await expect.poll(async () => {
    const row = await repository.kysely.selectFrom("chat_runs").select("status")
      .where("id", "=", runId).executeTakeFirst();
    return row?.status ?? null;
  }, { timeout: 5_000, interval: 20 })
    .toSatisfy((status) => ["running", "waiting_for_approval", "waiting_for_input"].includes(status!));
}

describe("live voice session policy at admission", () => {
  it("normalizes forged voice provenance on a typed admission to an honest typed policy", async () => {
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => toolCapableCatalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(completing("must_not_start"))]),
    });
    try {
      // No live session owns the Chat, so a caller-supplied voice source and
      // voiceSessionId are unverifiable claims: admission strips them and
      // stamps the honest "typed" source rather than persisting forgery.
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        runPolicy: {
          memoryMode: "ordinary",
          nativeCheckpointPolicy: "reusable",
          source: "voice",
          voiceSessionId: "vsession_live",
        },
      }));
      expect(admitted.run.runPolicy?.source).toBe("typed");
      expect(admitted.run.runPolicy?.voiceSessionId).toBeUndefined();
      expect(admitted.run.runPolicy?.executionPolicy).toBeUndefined();
      await orchestrator.drain();
    } finally {
      await orchestrator.close();
    }
  });

  it("ignores simulator voice flags but admits/retries server-qualified policies", async () => {
    vi.stubEnv("MATRIX_VOICE_SIMULATOR", "1");
    let attempt = 0;
    const orchestrator = new CanonicalChatOrchestrator({
      repository, catalog: { getCatalog: async () => toolCapableCatalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(async function* () {
        attempt += 1;
        yield { type: "run.completed", outcome: attempt === 2 ? "failed" : "completed" };
      })]),
    });
    try {
      const request = turnRequest({ runPolicy: { memoryMode: "ordinary", nativeCheckpointPolicy: "reusable", source: "voice" } });
      // A forged voice source never unlocks voice semantics — the run is a
      // plain typed run until a live session stamps authoritative policy.
      const forged = await orchestrator.admitTurn(principal, owner, "chat_voice", request);
      expect(forged.run.runPolicy?.source).toBe("typed");
      await orchestrator.drain();
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_session_turn_qualified",
        baseRevision: await currentRevision(),
        runPolicy: { memoryMode: "ordinary", nativeCheckpointPolicy: "reusable", source: "voice" },
      }), { sessionPolicy: liveSession });
      await orchestrator.drain();
      const failed = await repository.get(owner, "chat_voice");
      const retried = await orchestrator.retryTurn(principal, owner, "chat_voice", admitted.turn.id, { clientRequestId: "req_session_retry", baseRevision: failed!.chat.revision });
      expect(retried.run.runPolicy?.executionPolicy).toEqual(liveSession.executionPolicy);
      await orchestrator.drain(); expect(attempt).toBe(3);
    } finally { await orchestrator.close(); }
  });

  it("normalizes a forged voice claim on a queued turn even in simulator mode", async () => {
    vi.stubEnv("MATRIX_VOICE_SIMULATOR", "1");
    const { start, release } = gated();
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => toolCapableCatalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(start)]),
    });
    try {
      const active = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_active_for_simulator_queue",
      }));
      await waitForActive(active.run.id);
      const queued = await orchestrator.enqueueQueuedTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_simulator_voice_queue", baseRevision: await currentRevision(),
        runPolicy: { memoryMode: "ordinary", nativeCheckpointPolicy: "reusable", source: "voice", voiceSessionId: "vsession_live" },
      }));
      expect(queued.queuedTurn.runPolicy?.source).toBe("typed");
      expect(queued.queuedTurn.runPolicy?.voiceSessionId).toBeUndefined();
      expect(queued.queuedTurn.runPolicy?.executionPolicy).toBeUndefined();
    } finally {
      release();
      await orchestrator.drain();
      await orchestrator.close();
    }
  });

  it("stamps session policy onto a typed turn admitted while the session owns the chat", async () => {
    const { lookup, set } = createVoiceSessionPolicyLookup();
    set({ policyForChat: (chatId) => chatId === "chat_voice" ? liveSession : undefined });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(completing("native_typed"))]),
      voiceSessionPolicy: lookup,
    });
    try {
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        permissionMode: "full_access", // the session clamps it
      }));
      expect(admitted.admission).toBe("accepted");
      expect(admitted.run.permissionMode).toBe("supervised");
      expect(admitted.run.runPolicy).toMatchObject({
        memoryMode: "ordinary",
        nativeCheckpointPolicy: "reusable",
        source: "typed",
        voiceSessionId: "vsession_live",
      });
      const stored = await repository.kysely.selectFrom("chat_runs").selectAll()
        .where("id", "=", admitted.run.id).executeTakeFirstOrThrow();
      expect(stored.permission_mode).toBe("supervised");
      expect(CanonicalChatRunPolicySchema.parse(stored.run_policy)).toMatchObject({
        memoryMode: "ordinary",
        voiceSessionId: "vsession_live",
      });
    } finally {
      await orchestrator.close();
    }
  });

  it("applies the engine-supplied session policy hint for spoken finals", async () => {
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(completing("native_spoken"))]),
    });
    try {
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_spoken_hint",
        runPolicy: {
          memoryMode: "ordinary",
          nativeCheckpointPolicy: "reusable",
          source: "voice",
          voiceSessionId: "vsession_live",
        },
      }), { sessionPolicy: liveSession });
      expect(admitted.run.runPolicy).toMatchObject({
        memoryMode: "ordinary",
        source: "voice", // caller channel preserved
        voiceSessionId: "vsession_live",
      });
    } finally {
      await orchestrator.close();
    }
  });

  it("persists session policy on queued turns and the claimed run", async () => {
    const { lookup, set } = createVoiceSessionPolicyLookup();
    set({ policyForChat: () => liveSession });
    const { start, release } = gated();
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(start)]),
      voiceSessionPolicy: lookup,
    });
    try {
      const active = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_active_for_queue",
      }));
      expect(active.run.runPolicy?.voiceSessionId).toBe("vsession_live");
      await waitForActive(active.run.id);
      const queued = await orchestrator.enqueueQueuedTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_queued_in_session",
        baseRevision: await currentRevision(),
        permissionMode: "full_access",
      }));
      const queuedRow = await repository.kysely.selectFrom("chat_queued_turns").selectAll()
        .where("id", "=", queued.queuedTurn.id).executeTakeFirstOrThrow();
      expect(queuedRow.permission_mode).toBe("supervised");
      expect(CanonicalChatRunPolicySchema.parse(queuedRow.run_policy)).toMatchObject({
        memoryMode: "ordinary",
        nativeCheckpointPolicy: "reusable",
        voiceSessionId: "vsession_live",
      });
      release();
      await expect.poll(async () => {
        const row = await repository.kysely.selectFrom("chat_queued_turns")
          .select("status").where("id", "=", queued.queuedTurn.id).executeTakeFirst();
        return row?.status;
      }, { timeout: 5_000, interval: 25 }).toBe("claimed");
      const claimedRun = await repository.kysely.selectFrom("chat_runs").selectAll()
        .where("id", "=", (await repository.kysely.selectFrom("chat_queued_turns")
          .select("claimed_run_id").where("id", "=", queued.queuedTurn.id)
          .executeTakeFirstOrThrow()).claimed_run_id!)
        .executeTakeFirstOrThrow();
      // The claimed run inherits the queued policy verbatim.
      expect(CanonicalChatRunPolicySchema.parse(claimedRun.run_policy)).toMatchObject({
        memoryMode: "ordinary",
        voiceSessionId: "vsession_live",
      });
      expect(claimedRun.permission_mode).toBe("supervised");
    } finally {
      release();
      await orchestrator.close();
    }
  });

  it("revalidates frozen inventory on typed queue claim, retry and both steering paths", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    const loaded = adapter(async function* () { starts++; await gate; yield { type: "run.completed", outcome: "failed" }; });
    loaded.steer = vi.fn(async () => undefined);
    let qualified = liveSession.executionPolicy;
    const qualify = vi.fn(async () => qualified);
    loaded.qualifyPolicy = qualify;
    const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => toolCapableCatalog() }, adapters: new CanonicalChatProviderRegistry([loaded]), voiceSessionPolicy: { policyForChat: () => liveSession } });
    try {
      const active = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({ clientRequestId: "req_policy_active" }));
      await waitForActive(active.run.id);
      const queued = await orchestrator.enqueueQueuedTurn(principal, owner, "chat_voice", turnRequest({ clientRequestId: "req_policy_queue", baseRevision: await currentRevision() }));
      qualified = { ...liveSession.executionPolicy, revision: "actions_v2" };
      await expect(orchestrator.steerRun(owner, "chat_voice", active.run.id, { clientRequestId: "req_policy_steer", expectedTurnId: active.turn.id, parts: [{ type: "text", text: "escape" }] })).rejects.toThrow();
      await expect(orchestrator.steerQueuedTurn(owner, "chat_voice", active.run.id, queued.queuedTurn.id, { clientRequestId: "req_policy_queue_steer", expectedTurnId: active.turn.id, baseRevision: await currentRevision() })).rejects.toThrow();
      expect(loaded.steer).not.toHaveBeenCalled();
      release(); await orchestrator.drain();
      await expect.poll(async () => (await repository.kysely.selectFrom("chat_queued_turns").select("status").where("id", "=", queued.queuedTurn.id).executeTakeFirst())?.status, { timeout: 5_000 }).toBe("claimed");
      await orchestrator.drain(); expect(starts).toBe(1);
      const qualificationsBeforeRetry = qualify.mock.calls.length;
      await expect(orchestrator.retryTurn(principal, owner, "chat_voice", active.turn.id, { clientRequestId: "req_policy_retry", baseRevision: await currentRevision() })).rejects.toThrow();
      expect(qualify).toHaveBeenCalledTimes(qualificationsBeforeRetry + 1);
    } finally { release(); await orchestrator.close(); }
  });

  it("does not stamp session policy after the provider is cleared", async () => {
    const { lookup, set, clear } = createVoiceSessionPolicyLookup();
    const provider = { policyForChat: () => liveSession };
    set(provider);
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(completing("native_free"))]),
      voiceSessionPolicy: lookup,
    });
    try {
      clear(provider);
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_after_clear",
      }));
      expect(admitted.run.runPolicy).toBeUndefined();
      expect(admitted.run.permissionMode).toBe("supervised");
    } finally {
      await orchestrator.close();
    }
  });

  it("fails closed when the policy lookup throws", async () => {
    const { lookup, set } = createVoiceSessionPolicyLookup();
    set({
      policyForChat: () => {
        throw new Error("session registry unavailable");
      },
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(completing("native_closed"))]),
      voiceSessionPolicy: lookup,
    });
    try {
      await expect(orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        clientRequestId: "req_lookup_failure",
      }))).rejects.toMatchObject({ status: 503 });
      const runs = await repository.kysely.selectFrom("chat_runs").select("id")
        .where("chat_id", "=", "chat_voice").execute();
      expect(runs).toHaveLength(0); // nothing admitted without proven policy
    } finally {
      await orchestrator.close();
    }
  });
});

describe("admissionPolicyForTurn", () => {
  it("passes through when no session owns the chat", () => {
    const requested = { permissionMode: "supervised" };
    expect(admissionPolicyForTurn(requested, undefined)).toBe(requested);
  });

  it("lets the live session override conflicting request policy", () => {
    const result = admissionPolicyForTurn({
      permissionMode: "full_access",
      runPolicy: {
        memoryMode: "ordinary",
        nativeCheckpointPolicy: "reusable",
        source: "typed",
        voiceSessionId: "vsession_stale",
        memoryTools: ["memory_profile"],
      },
    }, { ...liveSession, memoryMode: "session_only" });
    expect(result.permissionMode).toBe("supervised");
    expect(result.runPolicy).toMatchObject({
      memoryMode: "session_only",
      nativeCheckpointPolicy: "disposable",
      source: "typed",
      voiceSessionId: "vsession_live",
    });
    // Session-only cannot carry memory tools — the allowlist is dropped.
    expect(result.runPolicy?.memoryTools).toBeUndefined();
  });
});

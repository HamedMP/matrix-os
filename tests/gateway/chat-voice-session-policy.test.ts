/**
 * Live voice-session policy enforcement at canonical admission
 * (specs/535-aoede-rewrite, FR-037): while a session owns a Chat, its frozen
 * memory/checkpoint/permission policy is stamped onto chat_runs and
 * chat_queued_turns for spoken and typed turns alike — never bypassable by a
 * request-supplied policy.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  memoryMode: "session_only" as const,
  permissionMode: "supervised",
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
  it("rejects a voice-source run when the selected harness exposes tool capability", async () => {
    const unsafeCatalog = catalog();
    unsafeCatalog.drivers[0]!.capabilityClass = "coding_agent";
    unsafeCatalog.instances[0]!.models[0]!.capabilities = ["tools"];
    unsafeCatalog.instances[0]!.models[0]!.supportsToolUse = true;
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => unsafeCatalog },
      adapters: new CanonicalChatProviderRegistry([adapter(completing("must_not_start"))]),
    });
    try {
      await expect(orchestrator.admitTurn(principal, owner, "chat_voice", turnRequest({
        runPolicy: {
          memoryMode: "session_only",
          nativeCheckpointPolicy: "disposable",
          source: "voice",
          voiceSessionId: "vsession_live",
        },
      }))).rejects.toMatchObject({ status: 400, safeError: { code: "capability_mismatch" } });
      const runs = await repository.kysely.selectFrom("chat_runs").select("id").execute();
      expect(runs).toHaveLength(0);
    } finally {
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
        memoryMode: "session_only",
        nativeCheckpointPolicy: "disposable",
        source: "typed",
        voiceSessionId: "vsession_live",
      });
      const stored = await repository.kysely.selectFrom("chat_runs").selectAll()
        .where("id", "=", admitted.run.id).executeTakeFirstOrThrow();
      expect(stored.permission_mode).toBe("supervised");
      expect(CanonicalChatRunPolicySchema.parse(stored.run_policy)).toMatchObject({
        memoryMode: "session_only",
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
          memoryMode: "session_only",
          nativeCheckpointPolicy: "disposable",
          source: "voice",
          voiceSessionId: "vsession_live",
        },
      }), { sessionPolicy: liveSession });
      expect(admitted.run.runPolicy).toMatchObject({
        memoryMode: "session_only",
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
        memoryMode: "session_only",
        nativeCheckpointPolicy: "disposable",
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
        memoryMode: "session_only",
        voiceSessionId: "vsession_live",
      });
      expect(claimedRun.permission_mode).toBe("supervised");
    } finally {
      release();
      await orchestrator.close();
    }
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
    }, liveSession);
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

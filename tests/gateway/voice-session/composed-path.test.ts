/**
 * Composed end-to-end voice-session path through the production seams:
 *
 *   authenticated REST create -> one-time ticket -> WebSocket upgrade ->
 *   client.ready -> capture -> simulator transcript -> canonical admission ->
 *   provider assistant deltas -> simulator synthesis -> durable delivery ->
 *   playback acknowledgements -> terminal complete -> canonical export.
 *
 * Every boundary is real: Hono routes, VoiceTicketAuthority, VoiceSessionEngine,
 * createCanonicalVoicePorts, ChatRepository + ChatVoiceDeliveryRepository on
 * PGlite, CanonicalChatOrchestrator, and the simulator media adapter. The only
 * stub is the canonical provider adapter, which is the designated fake seam:
 * it replaces the network model, not an internal boundary.
 *
 * Note: the wire contract requires finality ids to match `vfinal_`, so the
 * scenario uses "vfinal_1" — a short `vf_1` id would emit a transcript.final
 * frame that fails VoiceServerFrameSchema and cannot honestly ride the wire.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import {
  VoiceServerFrameSchema,
  type VoiceServerFrame,
} from "@matrix-os/contracts/voice-session";
import {
  SimulatorVoiceMediaAdapter,
  VoiceMediaAdapterRegistry,
  createAdapterCapabilityPort,
} from "../../../packages/gateway/src/voice-session/adapter.js";
import {
  canonicalVoiceDecision,
  canonicalVoiceSelectionRequirements,
  createCanonicalVoicePorts,
} from "../../../packages/gateway/src/voice-session/canonical-ports.js";
import { validateChatProviderSelection } from "../../../packages/gateway/src/chat/provider-catalog.js";
import { VoiceSessionEngine } from "../../../packages/gateway/src/voice-session/engine.js";
import { createSystemVoiceClock } from "../../../packages/gateway/src/voice-session/ports.js";
import {
  createVoiceSessionRoutes,
  registerVoiceSessionWebSocketRoute,
} from "../../../packages/gateway/src/voice-session/routes.js";
import type { VoiceSimulatorScenario } from "../../../packages/gateway/src/voice-session/simulator-types.js";
import {
  VoiceTicketAuthority,
  createVoiceOriginAllowlist,
} from "../../../packages/gateway/src/voice-session/ticket-auth.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import {
  CanonicalChatProviderRegistry,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunInput,
} from "../../../packages/gateway/src/chat/provider-adapter.js";
import { createVoiceSessionPolicyLookup } from "../../../packages/gateway/src/chat/voice-session-policy.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { ChatVoiceDeliveryRepository } from "../../../packages/gateway/src/chat/voice-delivery-repository.js";
import { ActionRepository } from "../../../packages/gateway/src/chat/action-repository.js";
import { createCanonicalActionAuthority } from "../../../packages/gateway/src/chat/action-authority.js";
import { createCanonicalActionTools } from "../../../packages/gateway/src/chat/action-tools.js";
import { sha256Hex } from "../../../packages/gateway/src/chat/argument-digest.js";
import type { ChatOwner } from "../../../packages/gateway/src/chat/records.js";
import type { RequestPrincipal } from "../../../packages/gateway/src/request-principal.js";

const CHAT_ID = "chat_composed_voice";
const OWNER_ID = "owner_composed_voice";
const OWNER: ChatOwner = { type: "personal", ownerId: OWNER_ID };
const PRINCIPAL: RequestPrincipal = { userId: OWNER_ID, source: "jwt" };
const TRANSCRIPT = "status report please";
const ASSISTANT_D1 = "Hello";
const ASSISTANT_D2 = " world";
const ASSISTANT_TEXT = ASSISTANT_D1 + ASSISTANT_D2;
const FIVE_APP_TOOLS = [
  "matrix_list_apps", "matrix_inspect_app", "matrix_search_workspace",
  "matrix_open_app", "matrix_apply_app_files",
] as const;
const EXECUTION_POLICY = {
  revision: "codex_canonical_v1",
  actionMode: "canonical_actions" as const,
  workspaceScope: "apps",
  tools: [...FIVE_APP_TOOLS],
  delegation: false,
};

const CAPTURE_AUDIO = {
  codec: "pcm_s16le",
  sampleRateHz: 16_000,
  channels: 1,
  frameDurationMs: 20,
} as const;

const catalog: CanonicalProviderCatalog = CanonicalProviderCatalogSchema.parse({
  revision: "catalog_composed_voice",
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
    catalogRevision: "catalog_composed_voice",
    models: [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      availability: "available",
      capabilities: ["reasoning"],
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
      attachments: ["file", "image", "structured_ref"],
      tools: [...FIVE_APP_TOOLS],
      approvals: true,
      approvalBinding: "argument_digest",
      userInput: true,
      worktrees: "optional",
      resources: ["file", "folder", "project", "task", "app", "terminal_session"],
      interactionModes: ["default"],
      permissionModes: ["supervised", "full_access"],
    },
  }],
});

describe("voice session composed path", () => {
  let pglite: KyselyPGlite;
  let repository: ChatRepository;
  let home: string;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
    home = await mkdtemp(join(tmpdir(), "matrix-aoede-composed-"));
    await mkdir(join(home, "apps", "notes", "src"), { recursive: true });
    await writeFile(join(home, "apps", "notes", "matrix.json"), JSON.stringify({
      slug: "notes", name: "Notes", version: "1.0.0", runtime: "vite", runtimeVersion: "^24.0.0", scope: "personal",
      permissions: [], build: { install: "pnpm install --frozen-lockfile", command: "vite build", output: "dist" },
    }));
    await writeFile(join(home, "apps", "notes", "package.json"), JSON.stringify({
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
      dependencies: { react: "19.0.0", "react-dom": "19.0.0" }, devDependencies: { vite: "7.0.0" },
    }));
    await writeFile(join(home, "apps", "notes", "index.html"), "<div id=\"root\"></div>");
    await writeFile(join(home, "apps", "notes", "src", "main.tsx"), "export const title = 'Old notes';\n");
    await repository.create(OWNER, {
      id: CHAT_ID,
      clientRequestId: `req_${randomBytes(8).toString("hex")}`,
      title: "Composed voice chat",
      currentSelection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
    });
  });

  afterEach(async () => {
    await repository.kysely.destroy();
    await rm(home, { recursive: true, force: true });
  });

  it("authenticated REST -> ticket -> upgrade -> capture -> canonical admission -> provider -> synthesis -> delivery -> acks -> complete", async () => {
    // ---- Real seam wiring -------------------------------------------------
    const fakeExternalBoundaries = Object.freeze({ speech: "SimulatorVoiceMediaAdapter", provider: "deterministic canonical model" });
    expect(fakeExternalBoundaries).toEqual({
      speech: "SimulatorVoiceMediaAdapter",
      provider: "deterministic canonical model",
    });
    const deliveries = new ChatVoiceDeliveryRepository(repository.kysely);
    const providerCalls: CanonicalProviderRunInput[] = [];
    const actionRepository = new ActionRepository(repository.kysely);
    const tools = createCanonicalActionTools({ homeForOwner: async () => home });
    let orchestrator!: CanonicalChatOrchestrator;
    let answerClarification!: () => void;
    const clarification = new Promise<void>((resolve) => { answerClarification = resolve; });
    const actions = createCanonicalActionAuthority({
      repository: actionRepository,
      tools,
      qualifyPolicy: async () => EXECUTION_POLICY,
      onEvent: async (identity, event) => orchestrator.projectActionEvent(identity, event),
    });
    const provider: CanonicalChatProviderAdapter<{ sessionId: string }> = {
      driverKind: "codex",
      stateSchemaVersion: 1,
      qualifyPolicy: async () => EXECUTION_POLICY,
      parseState(value) {
        if (!value || typeof value !== "object"
          || typeof (value as { sessionId?: unknown }).sessionId !== "string") {
          throw new Error("invalid adapter state");
        }
        return value as { sessionId: string };
      },
      serializeState: (value) => value,
      async *start(input) {
        providerCalls.push(input);
        yield { type: "state.updated", state: { sessionId: `native_${randomBytes(4).toString("hex")}` } };
        yield {
          type: "input.requested",
          requestId: "req_composed_clarification",
          title: "Choose style",
          safeDescription: "Choose the notes heading style.",
          questions: [{
            questionId: "style", header: "Style", question: "Which heading style?",
            options: [{ label: "Concise", description: "Use a short heading." }],
            allowOther: false, secret: false,
          }],
        };
        await clarification;
        const invoke = async (index: number, toolId: typeof FIVE_APP_TOOLS[number], args: unknown) => {
          try {
            return await input.actions!.invoke({
              owner: input.owner, chatId: input.chatId, runId: input.runId,
              actionId: `action_${String(index).padStart(32, "0")}`, toolId, arguments: args,
              executionPolicy: input.runPolicy!.executionPolicy!, signal: input.signal,
            });
          } catch (error) {
            throw new Error(`composed tool failed: ${toolId}`, { cause: error });
          }
        };
        await invoke(1, "matrix_list_apps", {});
        await invoke(2, "matrix_inspect_app", { app: "notes", paths: ["src/main.tsx"] });
        await invoke(3, "matrix_search_workspace", { app: "notes", query: "Old notes" });
        await invoke(4, "matrix_open_app", { app: "notes" });
        const oldText = await readFile(join(home, "apps", "notes", "src", "main.tsx"), "utf8");
        await invoke(5, "matrix_apply_app_files", { app: "notes", files: [{
          path: "src/main.tsx", content: "export const title = 'Concise notes';\n", expectedSha256: sha256Hex(oldText),
        }] });
        yield { type: "assistant.delta", delta: ASSISTANT_D1 };
        yield { type: "assistant.delta", delta: ASSISTANT_D2 };
        yield {
          type: "run.completed",
          outcome: "completed",
          tokenUsage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        };
      },
      async submitInput(input) {
        expect(input).toMatchObject({
          requestId: "req_composed_clarification",
          structuredAnswers: { style: ["Concise"] },
        });
        answerClarification();
      },
    };
    const providerRegistry = new CanonicalChatProviderRegistry([provider]);

    const onAiGeneration = vi.fn();
    const policyLookup = createVoiceSessionPolicyLookup();
    orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog },
      adapters: providerRegistry,
      actions,
      voiceSessionPolicy: policyLookup.lookup,
      onAiGeneration,
    });

    const voicePorts = createCanonicalVoicePorts({ orchestrator, repository, deliveries });
    const tickets = new VoiceTicketAuthority();
    const scenario: VoiceSimulatorScenario = {
      scenarioId: "composed_voice_path",
      version: 1,
      initialEpoch: 1,
      limits: { maxQueuedAudioMs: 10_000, maxDurationMs: 60_000 },
      timeline: [{
        // Provider timelines are relative to adapter start (`client.ready`),
        // not capture start. Leave enough deterministic room for the capture
        // frame to enter the serialized session queue first.
        atMs: 1_000,
        type: "transcript.final",
        turnId: "vturn_1",
        finalityId: "vfinal_1",
        localOrder: 1,
        text: TRANSCRIPT,
      }],
    };
    const adapters = new VoiceMediaAdapterRegistry();
    adapters.register(new SimulatorVoiceMediaAdapter({ scenario, clock: createSystemVoiceClock() }));
    const capabilities = createAdapterCapabilityPort({
      registry: adapters,
      limits: { maxSessionSeconds: 3_600, maxIdleSeconds: 300 },
    });
    const engine = new VoiceSessionEngine({
      admission: voicePorts.admission,
      delivery: voicePorts.delivery,
      chatEvents: voicePorts.chatEvents,
      runControl: voicePorts.runControl,
      adapters,
      tickets,
    });
    policyLookup.set(engine.sessionPolicyLookup);

    const sent: unknown[] = [];
    let closed: { code: number; reason: string } | null = null;
    const ws = {
      send(data: string | ArrayBuffer) {
        sent.push(typeof data === "string" ? JSON.parse(data) : data);
      },
      close(code?: number, reason?: string) {
        closed = { code: code ?? 1000, reason: reason ?? "" };
      },
      raw: { bufferedAmount: 0 },
    };
    const sent2: unknown[] = [];
    let closed2: { code: number; reason: string } | null = null;
    const ws2 = {
      send(data: string | ArrayBuffer) {
        sent2.push(typeof data === "string" ? JSON.parse(data) : data);
      },
      close(code?: number, reason?: string) {
        closed2 = { code: code ?? 1000, reason: reason ?? "" };
      },
      raw: { bufferedAmount: 0 },
    };

    const upgradeEvents: WSEvents[] = [];
    const upgradeWebSocket = ((createEvents: (c: Context) => WSEvents) => (
      (c: Context) => {
        upgradeEvents.push(createEvents(c));
        return Promise.resolve(c.text("upgrade-planned"));
      }
    )) as unknown as UpgradeWebSocket;

    const app = new Hono();
    app.route("/", createVoiceSessionRoutes({
      engine,
      resolvePrincipal: () => PRINCIPAL,
      chatAccess: voicePorts.chatAccess,
      capabilities,
      canonicalDecision: () => canonicalVoiceDecision({
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        catalog,
        qualifiedPolicy: EXECUTION_POLICY,
      }),
    }));
    registerVoiceSessionWebSocketRoute({
      app,
      upgradeWebSocket,
      engine,
      tickets,
      isOriginAllowed: createVoiceOriginAllowlist(["https://app.example.com"]),
    });

    const frames = () => sent.map((entry) => VoiceServerFrameSchema.parse(entry));
    let sessionId = "";

    try {
      // ---- Step 1: authenticated REST capabilities + session create ------
      const capabilitiesResponse = await app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`);
      expect(capabilitiesResponse.status).toBe(200);
      const capabilityBody = await capabilitiesResponse.json() as {
        status: string; transportModes: string[]; turnModes: string[];
      };
      expect(capabilityBody.status).toBe("available");
      expect(capabilityBody.transportModes).toContain("relayed_websocket");
      expect(capabilityBody.turnModes).toContain("hands_free");

      const create = await app.request(`http://test/api/chats/${CHAT_ID}/voice/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientRequestId: "req_composed_voice_session",
          turnMode: "hands_free",
          memoryMode: "ordinary",
          selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
          interactionMode: "default",
          permissionMode: "supervised",
        }),
      });
      expect(create.status).toBe(201);
      const body = await create.json() as {
        sessionId: string;
        chatId: string;
        outcome: string;
        status: string;
        transport: { kind: string; url: string; ticket: string; expiresAt: string; epoch: number };
      };
      sessionId = body.sessionId;
      expect(sessionId).toMatch(/^vs_/);
      expect(body.chatId).toBe(CHAT_ID);
      expect(body.outcome).toBe("created");
      expect(body.status).toBe("connecting");
      expect(body.transport.kind).toBe("relayed_websocket");
      expect(body.transport.url).toBe(`/ws/chats/${CHAT_ID}/voice/${sessionId}`);
      expect(body.transport.ticket).toMatch(/^vt_/);
      expect(body.transport.epoch).toBe(1);
      expect(tickets.describeSession(sessionId)?.state).toBe("minted");

      // ---- Step 2: WebSocket upgrade consumes the one-time ticket --------
      const upgrade = await app.request(
        `http://test${body.transport.url}?ticket=${body.transport.ticket}`,
        { headers: { origin: "https://app.example.com" } },
      );
      expect(upgrade.status).toBe(200);
      const events = upgradeEvents[0];
      expect(events).toBeDefined();
      events!.onOpen?.({} as never, ws as never);
      expect(tickets.describeSession(sessionId)?.state).toBe("consumed");
      await engine.drain(sessionId);

      // ---- Step 3: replaying the consumed ticket is rejected -------------
      const replay = await app.request(
        `http://test${body.transport.url}?ticket=${body.transport.ticket}`,
        { headers: { origin: "https://app.example.com" } },
      );
      expect(replay.status).toBe(200);
      upgradeEvents[1]!.onOpen?.({} as never, ws2 as never);
      expect(closed2).toEqual({ code: 1008, reason: "Unauthorized" });
      expect(sent2).toHaveLength(0);

      // ---- Step 4: client.ready -> simulator adapter -> listening --------
      let sequence = 0;
      const epoch = body.transport.epoch;
      const sendFrame = (fields: Record<string, unknown>) => {
        events!.onMessage?.({ data: JSON.stringify({
          contractVersion: 1, sessionId, epoch, sequence: ++sequence, ...fields,
        }) }, ws as never);
      };
      sendFrame({ type: "client.ready", audio: CAPTURE_AUDIO, capabilities: {
        formats: [CAPTURE_AUDIO], binaryAudio: false, maxAudioFrameBytes: 65_536,
        deviceChangeEvents: false,
      } });
      await vi.waitFor(() => {
        expect(frames().some((f) => f.type === "session.state" && f.state === "listening")).toBe(true);
      }, { timeout: 5_000, interval: 15 });

      // ---- Step 5: capture -> simulator transcript -> canonical admit ----
      sendFrame({ type: "capture.start", turnId: "vturn_1", mode: "hands_free" });
      await vi.waitFor(() => {
        expect(frames().some((f) => f.type === "transcript.final")).toBe(true);
      }, { timeout: 5_000, interval: 15 });
      const transcript = frames().find((f): f is Extract<VoiceServerFrame, { type: "transcript.final" }> => f.type === "transcript.final")!;
      expect(transcript.turnId).toBe("vturn_1");
      expect(transcript.finalityId).toBe("vfinal_1");
      expect(transcript.localOrder).toBe(1);
      expect(transcript.text).toBe(TRANSCRIPT);
      expect(transcript.canonicalTurnId).toMatch(/^cturn_/);

      // ---- Step 6: provider dispatched via real orchestrator -------------
      await vi.waitFor(() => {
        expect(providerCalls).toHaveLength(1);
      }, { timeout: 10_000, interval: 15 });
      expect(providerCalls[0]!.prompt).toBe(TRANSCRIPT);
      expect(providerCalls[0]!.chatId).toBe(CHAT_ID);
      expect(providerCalls[0]!.turnId).toBe(transcript.canonicalTurnId);
      expect(providerCalls[0]!.runId).toMatch(/^run_/);
      expect(providerCalls[0]!.interactionMode).toBe("default");
      // The canonical decision owns the interaction/permission pair: the
      // create request's "supervised" is overridden by the server-owned
      // CANONICAL_VOICE_PERMISSION_MODE at session create.
      expect(providerCalls[0]!.permissionMode).toBe("full_access");
      expect(providerCalls[0]!.runPolicy).toMatchObject({
        memoryMode: "ordinary",
        source: "voice",
        voiceSessionId: sessionId,
      });
      // The server-qualified decision freezes the exact five-tool inventory;
      // neither the client nor the fake model boundary can widen it.
      expect(providerCalls[0]!.runPolicy?.executionPolicy).toEqual(EXECUTION_POLICY);
      expect(providerCalls[0]!.actions).toBe(actions);

      // ---- Step 7: bounded correlated input -> exact approval ------------
      const runId = providerCalls[0]!.runId;
      await vi.waitFor(async () => {
        const detail = await repository.getDetailPage(OWNER, CHAT_ID, { limit: 100 });
        expect(detail!.activities).toContainEqual(expect.objectContaining({
          type: "input.requested", requestId: "req_composed_clarification",
        }));
      }, { timeout: 5_000, interval: 15 });
      await expect(orchestrator.submitInput(OWNER, CHAT_ID, "run_competing", "req_composed_clarification", {
        clientRequestId: "req_wrong_run_input", structuredAnswers: { style: ["Concise"] },
      })).rejects.toThrow();
      await orchestrator.submitInput(OWNER, CHAT_ID, runId, "req_composed_clarification", {
        clientRequestId: "req_composed_input", structuredAnswers: { style: ["Concise"] },
      });

      const applyActionId = `action_${String(5).padStart(32, "0")}`;
      let approvalDigest = "";
      await vi.waitFor(async () => {
        const detail = await repository.getDetailPage(OWNER, CHAT_ID, { limit: 100 });
        const operation = detail!.operations?.find((candidate) => candidate.id === applyActionId);
        expect(operation?.state).toBe("waiting_for_approval");
        approvalDigest = operation!.argumentDigest;
        expect(detail!.activities).toContainEqual(expect.objectContaining({
          type: "approval.requested", approvalId: applyActionId, argumentDigest: approvalDigest,
        }));
      }, { timeout: 5_000, interval: 15 });
      await expect(orchestrator.submitApproval(OWNER, CHAT_ID, runId, applyActionId, {
        clientRequestId: "req_wrong_digest", decision: "approve", argumentDigest: "0".repeat(64),
      })).rejects.toThrow();
      expect((await actionRepository.get({ owner: OWNER, chatId: CHAT_ID, runId, actionId: applyActionId })).state)
        .toBe("waiting_for_approval");
      await orchestrator.submitApproval(OWNER, CHAT_ID, runId, applyActionId, {
        clientRequestId: "req_exact_digest", decision: "approve", argumentDigest: approvalDigest,
      });

      // ---- Step 8: synthesis + durable delivery --------------------------
      await vi.waitFor(() => {
        expect(frames().filter((f) => f.type === "response.audio").length).toBe(1);
        expect(frames().filter((f) => f.type === "response.audio_end").length).toBe(1);
      }, { timeout: 10_000, interval: 15 });
      const started = frames().find((f): f is Extract<VoiceServerFrame, { type: "response.started" }> => f.type === "response.started")!;
      const responseId = started.responseId;
      expect(responseId).toMatch(/^vresp_/);
      expect(started.runId).toBe(providerCalls[0]!.runId);
      const audioFrames = frames().filter((f): f is Extract<VoiceServerFrame, { type: "response.audio" }> => f.type === "response.audio");
      expect(audioFrames.map((f) => f.responseId)).toEqual([responseId]);
      expect(frames().some((f) => f.type === "session.error")).toBe(false);
      expect(frames().some((f) => f.type === "response.interrupted")).toBe(false);

      const pendingRecord = await deliveries.get(OWNER, CHAT_ID, responseId);
      expect(pendingRecord).not.toBeNull();
      expect(pendingRecord!.state).toBe("pending");
      expect(pendingRecord!.segments).toHaveLength(1);
      const [segment] = pendingRecord!.segments;
      expect(segment).toMatchObject({ textStart: 0, textEnd: ASSISTANT_TEXT.length });
      expect(audioFrames.map((f) => f.segmentId)).toEqual([segment!.segmentId]);
      expect(pendingRecord!.deliveredThroughMs).toBe(100);
      expect(pendingRecord!.acknowledgedSegment).toBeNull();

      const detail = await repository.getDetailPage(OWNER, CHAT_ID, { limit: 100 });
      expect(detail!.operations?.map((operation) => operation.toolId)).toEqual(FIVE_APP_TOOLS);
      expect(detail!.operations?.every((operation) => operation.state === "succeeded")).toBe(true);
      expect(detail!.operations?.find((operation) => operation.toolId === "matrix_open_app")?.result)
        .toEqual({ navigation: { kind: "open_app", app: "notes", path: "apps/notes" } });
      expect(detail!.operations?.find((operation) => operation.toolId === "matrix_apply_app_files")?.result)
        .toEqual(expect.objectContaining({
          artifact: { kind: "app", path: "apps/notes" },
          navigation: { kind: "open_app", app: "notes", path: "apps/notes" },
          files: [expect.objectContaining({ path: "apps/notes/src/main.tsx" })],
        }));
      expect(await readFile(join(home, "apps", "notes", "src", "main.tsx"), "utf8"))
        .toBe("export const title = 'Concise notes';\n");
      await expect(readFile(join(home, "src", "main.tsx"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      // ---- Step 8: final phrase acknowledgement completes delivery -------
      sendFrame({
        type: "playback.segment_played",
        responseId,
        segmentId: segment!.segmentId,
        deliveryRevision: pendingRecord!.revision,
        playedThroughMs: 100,
      });
      await vi.waitFor(async () => {
        const current = await deliveries.get(OWNER, CHAT_ID, responseId);
        expect(current!.state).toBe("complete");
      }, { timeout: 5_000, interval: 15 });
      const record = await deliveries.get(OWNER, CHAT_ID, responseId);
      expect(record!.acknowledgedSegment).toBe(segment!.segmentId);
      expect(record!.terminalReason).toBe("complete");
      expect(record!.effectiveTextEnd).toBe(ASSISTANT_TEXT.length);

      // ---- Step 10: canonical export proves persisted state --------------
      await orchestrator.drain();
      expect(onAiGeneration).toHaveBeenCalledTimes(1);
      expect(onAiGeneration).toHaveBeenCalledWith(expect.objectContaining({
        traceId: providerCalls[0]!.runId,
        provider: "openai",
        harness: "codex",
        model: "gpt-5.6-sol",
        responseCharacterCount: ASSISTANT_TEXT.length,
        productEvent: "gateway_chat_response_completed",
      }));

      const exported = await repository.exportChat(OWNER, CHAT_ID);
      expect(exported).not.toBeNull();
      expect(exported!.chat.chat).toMatchObject({
        id: CHAT_ID,
        ownerScope: { type: "personal", ownerId: OWNER_ID },
      });
      expect(exported!.chat.chat.revision).toBeGreaterThanOrEqual(4);
      expect(exported!.messages).toHaveLength(2);
      expect(exported!.messages[0]).toMatchObject({
        role: "user", state: "committed",
        turnId: transcript.canonicalTurnId,
        parts: [{ type: "text", text: TRANSCRIPT }],
      });
      expect(exported!.messages[1]).toMatchObject({
        role: "assistant", state: "committed",
        runId: providerCalls[0]!.runId,
        parts: [{ type: "text", text: ASSISTANT_TEXT }],
      });
      expect(exported!.turns).toHaveLength(1);
      expect(exported!.turns[0]).toMatchObject({
        id: transcript.canonicalTurnId, status: "completed",
      });
      expect(exported!.turns[0]!.clientRequestId).toMatch(/^req_/);
      expect(exported!.runs).toHaveLength(1);
      expect(exported!.runs[0]).toMatchObject({
        id: providerCalls[0]!.runId, status: "completed", outcome: "completed",
      });

      // ---- Step 11: DELETE ends the session over the same REST seam ------
      const del = await app.request(
        `http://test/api/chats/${CHAT_ID}/voice/sessions/${sessionId}`,
        { method: "DELETE" },
      );
      expect(del.status).toBe(200);
      const delBody = await del.json() as { ended: boolean; alreadyTerminal: boolean; status: string };
      expect(delBody).toMatchObject({ ended: true, alreadyTerminal: false, status: "ended" });
      await engine.drain(sessionId);
      expect(closed).toEqual({ code: 1000, reason: "Session ended" });
      const finalStates = frames().filter((f) => f.type === "session.state").map((f) => f.state);
      expect(finalStates[0]).toBe("connecting");
      expect(finalStates).toContain("listening");
      expect(finalStates).toContain("thinking");
      expect(finalStates.at(-1)).toBe("ended");
      expect(frames().some((f) => f.type === "transport.going_away")).toBe(true);
      expect(tickets.describeSession(sessionId)?.state).toBe("consumed");
    } finally {
      await engine.drain(sessionId).catch(() => undefined);
      await engine.close();
      await orchestrator.close();
      policyLookup.clear(engine.sessionPolicyLookup);
      await repository.release();
    }
  }, 30_000);
});

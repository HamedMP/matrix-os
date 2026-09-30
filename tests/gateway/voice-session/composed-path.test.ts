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
import { createCanonicalVoicePorts } from "../../../packages/gateway/src/voice-session/canonical-ports.js";
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

describe("voice session composed path", () => {
  let pglite: KyselyPGlite;
  let repository: ChatRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
    await repository.create(OWNER, {
      id: CHAT_ID,
      clientRequestId: `req_${randomBytes(8).toString("hex")}`,
      title: "Composed voice chat",
      currentSelection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
    });
  });

  afterEach(async () => {
    await repository.kysely.destroy();
  });

  it("authenticated REST -> ticket -> upgrade -> capture -> canonical admission -> provider -> synthesis -> delivery -> acks -> complete", async () => {
    // ---- Real seam wiring -------------------------------------------------
    const deliveries = new ChatVoiceDeliveryRepository(repository.kysely);
    const providerCalls: CanonicalProviderRunInput[] = [];
    const provider: CanonicalChatProviderAdapter<{ sessionId: string }> = {
      driverKind: "codex",
      stateSchemaVersion: 1,
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
        yield { type: "assistant.delta", delta: ASSISTANT_D1 };
        yield { type: "assistant.delta", delta: ASSISTANT_D2 };
        yield {
          type: "run.completed",
          outcome: "completed",
          tokenUsage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        };
      },
    };
    const providerRegistry = new CanonicalChatProviderRegistry([provider]);

    const onAiGeneration = vi.fn();
    const policyLookup = createVoiceSessionPolicyLookup();
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog },
      adapters: providerRegistry,
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
        atMs: 30,
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
        expect(frames().some((f) => f.type === "response.started")).toBe(true);
      }, { timeout: 10_000, interval: 15 });
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0]!.prompt).toBe(TRANSCRIPT);
      expect(providerCalls[0]!.chatId).toBe(CHAT_ID);
      expect(providerCalls[0]!.turnId).toBe(transcript.canonicalTurnId);
      expect(providerCalls[0]!.runId).toMatch(/^run_/);
      expect(providerCalls[0]!.interactionMode).toBe("default");
      expect(providerCalls[0]!.permissionMode).toBe("supervised");
      expect(providerCalls[0]!.runPolicy).toMatchObject({
        memoryMode: "ordinary",
        source: "voice",
        voiceSessionId: sessionId,
      });

      // ---- Step 7: synthesis + durable delivery --------------------------
      await vi.waitFor(() => {
        expect(frames().filter((f) => f.type === "response.audio").length).toBe(2);
        expect(frames().filter((f) => f.type === "response.audio_end").length).toBe(2);
      }, { timeout: 10_000, interval: 15 });
      const started = frames().find((f): f is Extract<VoiceServerFrame, { type: "response.started" }> => f.type === "response.started")!;
      const responseId = started.responseId;
      expect(responseId).toMatch(/^vresp_/);
      expect(started.runId).toBe(providerCalls[0]!.runId);
      const audioFrames = frames().filter((f): f is Extract<VoiceServerFrame, { type: "response.audio" }> => f.type === "response.audio");
      expect(audioFrames.map((f) => f.responseId)).toEqual([responseId, responseId]);
      expect(frames().some((f) => f.type === "session.error")).toBe(false);
      expect(frames().some((f) => f.type === "response.interrupted")).toBe(false);

      const pendingRecord = await deliveries.get(OWNER, CHAT_ID, responseId);
      expect(pendingRecord).not.toBeNull();
      expect(pendingRecord!.state).toBe("pending");
      expect(pendingRecord!.segments).toHaveLength(2);
      const [seg0, seg1] = pendingRecord!.segments;
      expect(seg0).toMatchObject({ textStart: 0, textEnd: ASSISTANT_D1.length });
      expect(seg1).toMatchObject({ textStart: ASSISTANT_D1.length, textEnd: ASSISTANT_TEXT.length });
      expect(audioFrames.map((f) => f.segmentId)).toEqual([seg0!.segmentId, seg1!.segmentId]);
      expect(pendingRecord!.deliveredThroughMs).toBe(200);
      expect(pendingRecord!.acknowledgedSegment).toBeNull();

      // ---- Step 8: out-of-order ack is tracked, not completed ------------
      sendFrame({
        type: "playback.segment_played",
        responseId,
        segmentId: seg1!.segmentId,
        deliveryRevision: pendingRecord!.revision,
        playedThroughMs: 200,
      });
      await engine.drain(sessionId);
      let record = await deliveries.get(OWNER, CHAT_ID, responseId);
      expect(record!.state).toBe("pending");
      expect(record!.acknowledgedSegment).toBeNull();

      // ---- Step 9: ordered acks complete the delivery --------------------
      sendFrame({
        type: "playback.segment_played",
        responseId,
        segmentId: seg0!.segmentId,
        deliveryRevision: record!.revision,
        playedThroughMs: 100,
      });
      await engine.drain(sessionId);
      record = await deliveries.get(OWNER, CHAT_ID, responseId);
      expect(record!.state).toBe("playing");
      expect(record!.acknowledgedSegment).toBe(seg0!.segmentId);
      expect(record!.effectiveTextEnd).toBe(ASSISTANT_D1.length);

      sendFrame({
        type: "playback.segment_played",
        responseId,
        segmentId: seg1!.segmentId,
        deliveryRevision: record!.revision,
        playedThroughMs: 200,
      });
      await vi.waitFor(async () => {
        const current = await deliveries.get(OWNER, CHAT_ID, responseId);
        expect(current!.state).toBe("complete");
      }, { timeout: 5_000, interval: 15 });
      record = await deliveries.get(OWNER, CHAT_ID, responseId);
      expect(record!.acknowledgedSegment).toBe(seg1!.segmentId);
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
  }, 20_000);
});

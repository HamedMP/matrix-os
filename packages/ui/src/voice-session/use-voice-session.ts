"use client";

/**
 * Composes the REST session API, the relayed-WebSocket transport, the media
 * session, and the headless VoiceSessionController into a runnable client.
 *
 * Commands emitted by the controller become validated client frames; inbound
 * server frames feed both the controller (state) and media (playout). All
 * reconnects go through the authenticated REST reconnect route because
 * transport tickets are single-use.
 *
 * Collaborators: `./client-transport.js` owns the socket attachment,
 * `./client-reconnect.js` owns the bounded retry ladder, and
 * `./client-commands.js` routes controller commands. Public types live in
 * `./client-types.js`.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  VOICE_SESSION_CONTRACT_VERSION,
  VOICE_SESSION_LIMITS,
  VoiceCanonicalChatIdSchema,
  type AudioFormat,
  type ClientMediaCapabilities,
  type SafeVoiceError,
  type VoiceOutputAudioFormat,
} from "@matrix-os/contracts/voice-session";
import { VoiceSessionController, type VoiceSessionCommand } from "./controller.js";
import {
  createWebVoiceMediaSession,
  VoiceMediaError,
  type VoiceMediaCallbacks,
  type VoiceMediaSession,
} from "./media-session.js";
import {
  createVoiceSessionApi,
  VoiceSessionApiError,
  voiceErrorForCode,
  type CreateVoiceSessionRequest,
} from "./session-api.js";
import {
  capabilityUnavailableError,
  CONNECTION_LOST_FATAL,
  DEFAULT_VOICE_AUDIO_FORMAT,
  voiceWarn,
  type VoiceSessionClient,
  type VoiceSessionClientOptions,
  type VoiceSessionClientPhase,
  type VoiceSessionClientSnapshot,
  type VoiceSessionHook,
} from "./client-types.js";
import { createReconnectLoop, createRemoteCleanupQueue } from "./client-reconnect.js";
import { routeVoiceCommand } from "./client-commands.js";
import { createTransportAttachment, voiceDeclaredAudioFormat } from "./client-transport.js";

export {
  capabilityUnavailableError,
  CONNECTION_LOST_FATAL,
  DEFAULT_VOICE_AUDIO_FORMAT,
  type VoiceSessionClient,
  type VoiceSessionClientOptions,
  type VoiceSessionClientPhase,
  type VoiceSessionClientSnapshot,
  type VoiceSessionHook,
  type VoiceSessionRequestDefaults,
} from "./client-types.js";

const MAX_STATE_LISTENERS = 16;
const MAX_CREATE_ATTEMPTS = 2;

export function createVoiceSessionClient(options: VoiceSessionClientOptions): VoiceSessionClient {
  const api = createVoiceSessionApi({
    baseUrl: options.baseUrl,
    fetcher: options.fetcher,
    makeTimeoutSignal: options.makeTimeoutSignal,
  });
  const requestedAudio = options.audio ?? DEFAULT_VOICE_AUDIO_FORMAT;
  // Capture is mono: the pipeline reads one channel, so a stereo config is
  // normalized and the EFFECTIVE format is what client.ready advertises.
  const audio: AudioFormat = requestedAudio.channels === 1
    ? requestedAudio
    : { ...requestedAudio, channels: 1 };
  if (audio !== requestedAudio) {
    console.warn("[voice-session] stereo capture is unsupported; advertising mono (channels: 1)");
  }
  const declaredCapabilities = options.mediaCapabilities;
  const resolvedMediaCapabilities = (): ClientMediaCapabilities => declaredCapabilities === undefined
    ? {
        formats: [audio],
        binaryAudio: false,
        maxAudioFrameBytes: VOICE_SESSION_LIMITS.maxAudioFrameBytes,
        deviceChangeEvents: typeof navigator !== "undefined"
          && typeof navigator.mediaDevices?.addEventListener === "function",
      }
    : {
        ...declaredCapabilities,
        // Honest capabilities: the client never captures stereo, so declared
        // formats are normalized to what the pipeline actually produces.
        formats: declaredCapabilities.formats.map(
          (format): AudioFormat => (format.channels === 1 ? format : { ...format, channels: 1 }),
        ),
      };
  const maxReconnectAttempts = Math.max(
    0,
    Math.min(options.maxReconnectAttempts ?? VOICE_SESSION_LIMITS.maxReconnectAttempts, VOICE_SESSION_LIMITS.maxReconnectAttempts),
  );
  const setTimeoutFn = options.setTimeoutFn
    ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const clearTimeoutFn = options.clearTimeoutFn
    ?? ((timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));

  const listeners = new Set<() => void>();
  let controller: VoiceSessionController | null = null;
  let unsubscribeController: (() => void) | null = null;
  let media: VoiceMediaSession | null = null;
  let sessionId: string | null = null;
  let chatId: string | null = null;
  let phase: VoiceSessionClientPhase = "idle";
  let error: SafeVoiceError | null = null;
  let notice: SafeVoiceError | null = null;
  let reconnectStatus: VoiceSessionClientSnapshot["reconnectStatus"] = null;
  let activeTurnId: string | null = null;
  let ending = false;
  let disposed = false;
  let generation = 0;
  let startPromise: Promise<void> | null = null;
  // A transport failure leaves create outcome unknown. Keep the exact request
  // across the user's Retry so the server can reconcile the logical create.
  let unresolvedCreate: { chatId: string; request: CreateVoiceSessionRequest } | null = null;
  /** Output format declared by the capability response for playback fallback. */
  let declaredOutputAudio: VoiceOutputAudioFormat | undefined;
  let snapshot: VoiceSessionClientSnapshot = {
    phase, error, notice, sessionId, chatId, reconnectStatus, voice: null,
  };

  const emit = () => {
    snapshot = {
      phase,
      error,
      notice,
      sessionId,
      chatId,
      reconnectStatus,
      voice: controller?.getState() ?? null,
    };
    syncCapture();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (listenerError: unknown) {
        voiceWarn("[voice-session] state listener failed:", listenerError);
      }
    }
  };

  const setPhase = (next: VoiceSessionClientPhase) => {
    phase = next;
    emit();
  };

  const makeId = (prefix: "vturn_" | "req_"): string => {
    const custom = options.createId?.(prefix);
    if (custom !== undefined) return custom;
    const uuid = globalThis.crypto?.randomUUID?.();
    return `${prefix}${uuid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;
  };

  /** Feeds a locally-originated control event into the controller's fenced pipeline. */
  const injectFrame = (
    body:
      | { type: "transport.going_away"; retryAfterMs: number; reconnectAllowed: boolean }
      | ({ type: "session.error" } & SafeVoiceError),
  ): void => {
    if (!controller || !sessionId) return;
    const state = controller.getState();
    if (state.state === "ended") return;
    controller.receive({
      contractVersion: VOICE_SESSION_CONTRACT_VERSION,
      sessionId,
      epoch: state.epoch,
      sequence: state.sequence + 1,
      ...body,
    });
  };

  /**
   * Terminal failure teardown: stop capture first so no late audio chunk
   * escapes, then release the mic, retire the socket, and delete the remote
   * session when one was minted. Safe to call from any failure path —
   * release/delete are idempotent.
   */
  const failSession = (safeError: SafeVoiceError) => {
    reconnectLoop.cancel();
    activeTurnId = null;
    const held = media;
    if (held) {
      try {
        held.stopCapture();
      } catch (stopError: unknown) {
        voiceWarn("[voice-session] capture stop on failure failed:", stopError);
      }
      try {
        held.stopPlayback();
      } catch (playbackError: unknown) {
        voiceWarn("[voice-session] playback stop on failure failed:", playbackError);
      }
    }
    void releaseMedia();
    transport.retire();
    deleteRemote();
    error = safeError;
    injectFrame({ type: "session.error", ...safeError });
    phase = "failed";
    emit();
  };

  const releaseMedia = async () => {
    const held = media;
    media = null;
    if (!held) return;
    try {
      await held.release();
    } catch (releaseError: unknown) {
      voiceWarn("[voice-session] media release failed:", releaseError);
    }
  };

  /**
   * Bounded remote-session cleanup. A job is keyed by the captured
   * chat/session pair and settles ONLY after the remote DELETE confirms:
   * failures retry on the injected timers (max 3 attempts), concurrent
   * teardowns dedupe, and exhaustion parks the key in a separate bounded
   * failed registry — never marked settled — with a discoverable safe
   * notice on the snapshot. Failed keys are never retried automatically;
   * `retryCleanup` is the explicit, rate-limited escape hatch.
   */
  const cleanupQueue = createRemoteCleanupQueue({
    deleteRemote: (cid, sid) => api.deleteSession(cid, sid),
    setTimeoutFn,
    clearTimeoutFn,
    now: options.now,
    onRetry: (_cid, _sid, attempt, deleteError) => {
      voiceWarn(`[voice-session] remote session cleanup attempt ${attempt} failed:`, deleteError);
    },
    onExhausted: () => {
      notice = CONNECTION_LOST_FATAL;
      emit();
    },
    onSettled: () => {
      // A confirmed remote DELETE retires the cleanup-failure notice, but
      // never clobbers an unrelated warning (e.g. audio_backpressure).
      if (notice === CONNECTION_LOST_FATAL) {
        notice = null;
        emit();
      }
    },
  });

  const deleteRemote = () => {
    if (!sessionId || !chatId) return;
    cleanupQueue.enqueue(chatId, sessionId);
  };

  /**
   * Transport-loss halt: stop capture and every current/queued playback
   * locally. No wire frames are sent — halting audio must never imply that
   * the canonical run, model generation, or a tool was cancelled.
   */
  const haltMedia = () => {
    activeTurnId = null;
    const held = media;
    if (!held) return;
    try {
      held.stopCapture();
    } catch (stopError: unknown) {
      voiceWarn("[voice-session] capture stop on transport loss failed:", stopError);
    }
    try {
      held.stopPlayback();
    } catch (playbackError: unknown) {
      voiceWarn("[voice-session] playback stop on transport loss failed:", playbackError);
    }
  };

  async function teardownSession(remoteEnded: boolean): Promise<void> {
    reconnectLoop.cancel();
    activeTurnId = null;
    transport.retire();
    await releaseMedia();
    if (!remoteEnded) deleteRemote();
  }

  /**
   * Every teardown path fences an in-flight startFlow: bumping the generation
   * before tearing down makes each `stale()` gate reject the late-resolved
   * awaits (capabilities, permission, createSession) of a cancelled start.
   */
  const teardown = (remoteEnded: boolean): Promise<void> => {
    generation += 1;
    return teardownSession(remoteEnded);
  };

  const reconnectLoop = createReconnectLoop({
    isDisposed: () => disposed,
    generation: () => generation,
    session: () => (sessionId !== null && chatId !== null ? { sessionId, chatId } : null),
    api,
    maxAttempts: maxReconnectAttempts,
    setTimeoutFn,
    clearTimeoutFn,
    setPhase,
    failSession,
    onGrant: (grant) => {
      if (grant.kind !== "relayed_websocket") {
        failSession(voiceErrorForCode("unsupported_surface"));
        return;
      }
      reconnectStatus = null;
      transport.connect(grant);
    },
  });

  /** Projects a local `transport.going_away` into the controller so visible state tracks revival intent. */
  const injectGoingAway = () => injectFrame({
    type: "transport.going_away",
    retryAfterMs: reconnectLoop.retryAfter(),
    reconnectAllowed: true,
  });

  const transport = createTransportAttachment({
    sessionId: () => sessionId,
    controller: () => controller,
    media: () => media,
    lossIsReconnectable: () => !disposed && !ending && phase !== "ended" && phase !== "idle",
    audio,
    mediaCapabilities: resolvedMediaCapabilities,
    declaredOutputAudio: () => declaredOutputAudio,
    options,
    noteRetryAfter: (ms) => reconnectLoop.noteRetryAfter(ms),
    haltMedia,
    goingAway: injectGoingAway,
    onResumed: () => reconnectLoop.onResumed(),
    setPhase,
    failSession,
    scheduleReconnect: () => reconnectLoop.schedule(),
    setNotice: (safeError) => {
      notice = safeError;
      emit();
    },
    onTurnFinal: (turnId) => {
      if (options.request.turnMode !== "hands_free" || activeTurnId !== turnId || !media) return;
      media.stopCapture();
      activeTurnId = null;
      transport.current()?.send({ type: "capture.stop", turnId });
      // The final transcript is the server's authoritative completion event.
      // Re-enter capture while the lifecycle remains live, minting a fresh id.
      syncCapture();
    },
    onRemoteEnd: () => {
      // Server-side `session.state` -> ended is authoritative: tear down
      // without a DELETE and surface the terminal phase to the shell.
      void teardown(true);
      setPhase("ended");
    },
    onRemoteFailed: () => {
      // Server-side `session.state` -> failed intends reconnect-revival:
      // keep the bounded ladder when allowed, fail terminally otherwise.
      if (disposed || ending || phase === "ended" || phase === "idle") return;
      haltMedia();
      injectGoingAway();
      setPhase("reconnecting");
      reconnectLoop.schedule();
    },
  });

  /**
   * Per-session media callbacks, fenced by session identity: the ref is set
   * right after the factory returns, so a released or superseded media
   * session can never feed chunks, acks, or errors into the live session.
   */
  const makeMediaCallbacks = (held: { current: VoiceMediaSession | null }): VoiceMediaCallbacks => {
    const live = () => !disposed && !ending && held.current !== null && media === held.current;
    return {
      onAudioChunk: (chunk) =>
        live() ? (transport.current()?.send({ type: "capture.audio", ...chunk }) ?? false) : false,
      onSegmentPlayed: (ack) => {
        if (disposed || held.current === null || media !== held.current) return;
        try {
          controller?.acknowledgePlayback(ack);
        } catch (ackError: unknown) {
          voiceWarn("[voice-session] playback ack failed:", ackError);
        }
      },
      onBackpressure: () => {
        if (!live()) return;
        notice = voiceErrorForCode("audio_backpressure");
        emit();
      },
      onDeviceChanged: (change) => {
        if (!live()) return;
        transport.current()?.send({ type: "device.changed", ...change });
      },
      onError: (mediaError) => {
        // A late media error must never resurrect a torn-down session.
        if (held.current === null || media !== held.current || disposed || ending
          || phase === "idle" || phase === "ended" || phase === "failed") return;
        failSession(mediaError);
      },
    };
  };

  /**
   * Hands-free mode owns capture whenever the session is live: the controller
   * only emits capture.start/stop for push-to-talk, so the client translates
   * lifecycle into a continuous capture turn (which also enables barge-in).
   */
  const syncCapture = () => {
    if (!controller || !media || !sessionId || ending || disposed) return;
    if (options.request.turnMode !== "hands_free") return;
    const state = controller.getState().state;
    const wantsCapture = state === "listening" || state === "thinking" || state === "using_tool" || state === "speaking";
    if (wantsCapture && activeTurnId === null) {
      const turnId = makeId("vturn_");
      if (media.startCapture({ turnId })) {
        activeTurnId = turnId;
        transport.current()?.send({ type: "capture.start", turnId, mode: "hands_free" });
      }
    } else if (!wantsCapture && activeTurnId !== null) {
      media.stopCapture();
      const turnId = activeTurnId;
      activeTurnId = null;
      transport.current()?.send({ type: "capture.stop", turnId });
    }
  };

  const handleCommand = (command: VoiceSessionCommand): void => {
    routeVoiceCommand({
      media: () => media,
      transport: () => transport.current(),
      activeTurnId: () => activeTurnId,
      setActiveTurnId: (turnId) => {
        activeTurnId = turnId;
      },
      makeId,
      teardown,
      reconnect: () => void reconnectLoop.perform(true),
      onContinueInChat: () => {
        // Continuing in chat ends the voice session on every path; keep the
        // public phase truthful before handing off to the host surface.
        phase = "ended";
        emit();
        options.onContinueInChat?.();
      },
    }, command);
  };

  const buildRequest = (clientRequestId: string): CreateVoiceSessionRequest => ({
    clientRequestId,
    turnMode: options.request.turnMode,
    memoryMode: options.request.memoryMode ?? "ordinary",
    ...(options.request.requestedTransport === undefined
      ? {}
      : { requestedTransport: options.request.requestedTransport }),
    selection: options.request.selection,
    interactionMode: options.request.interactionMode,
    permissionMode: options.request.permissionMode,
    ...(options.request.locale === undefined ? {} : { locale: options.request.locale }),
  });

  const startFlow = async (parsedChatId: string): Promise<void> => {
    const gen = ++generation;
    const stale = () => disposed || generation !== gen;
    // A prior failed/ended session is fully retired before the new one starts.
    unsubscribeController?.();
    unsubscribeController = null;
    controller?.dispose();
    controller = null;
    await teardownSession(false);
    if (stale()) return;
    reconnectLoop.reset();
    ending = false;
    error = null;
    notice = null;
    reconnectStatus = null;
    sessionId = null;
    chatId = null;
    declaredOutputAudio = undefined;
    setPhase("starting");

    let capability;
    try {
      capability = await api.getCapabilities(parsedChatId);
    } catch (capabilityError: unknown) {
      if (!stale()) {
        failSession(capabilityError instanceof VoiceSessionApiError
          ? capabilityError.safeError
          : voiceErrorForCode("connection_failed"));
      }
      return;
    }
    if (stale()) return;
    if (capability.status === "unavailable") {
      failSession(capabilityUnavailableError(capability.reason));
      return;
    }
    // Optional capability field: the server may declare the synthesis output
    // format (e.g. 24 kHz PCM); segments without a per-frame format use it.
    declaredOutputAudio = voiceDeclaredAudioFormat(capability.outputAudio);

    const mediaRef: { current: VoiceMediaSession | null } = { current: null };
    const heldMedia = options.mediaFactory
      ? options.mediaFactory({ audio, callbacks: makeMediaCallbacks(mediaRef) })
      : createWebVoiceMediaSession({ audio, callbacks: makeMediaCallbacks(mediaRef) });
    mediaRef.current = heldMedia;
    media = heldMedia;
    try {
      await heldMedia.prepare({ onRationale: options.onPermissionRationale });
    } catch (mediaError: unknown) {
      // Fence callbacks BEFORE releasing: a prepare that rejects after
      // partial allocation can still emit late chunks/errors, and none may
      // reach this (or a future) session. Then release whatever the —
      // possibly custom — media implementation allocated before throwing;
      // failSession's releaseMedia would skip it now that `media` is null.
      mediaRef.current = null;
      media = null;
      try {
        await heldMedia.release();
      } catch (releaseError: unknown) {
        voiceWarn("[voice-session] media release after failed prepare failed:", releaseError);
      }
      if (!stale()) {
        failSession(mediaError instanceof VoiceMediaError
          ? mediaError.safeError
          : voiceErrorForCode("input_unavailable"));
      }
      return;
    }
    if (stale()) return;

    let created;
    const createAttempt = unresolvedCreate?.chatId === parsedChatId
      ? unresolvedCreate
      : { chatId: parsedChatId, request: buildRequest(makeId("req_")) };
    unresolvedCreate = createAttempt;
    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
      try {
        created = await api.createSession(parsedChatId, createAttempt.request);
        if (unresolvedCreate === createAttempt) unresolvedCreate = null;
        break;
      } catch (createError: unknown) {
        if (stale()) return;
        const safeError = createError instanceof VoiceSessionApiError
          ? createError.safeError
          : voiceErrorForCode("connection_failed");
        // Only transport ambiguity can mean the server created a session but
        // its response was lost. Retry that ambiguity with the SAME idempotency
        // key; all definitive HTTP failures settle immediately.
        if (safeError.code === "connection_failed" && attempt < MAX_CREATE_ATTEMPTS) continue;
        if (safeError.code !== "connection_failed" && unresolvedCreate === createAttempt) {
          unresolvedCreate = null;
        }
        failSession(safeError);
        return;
      }
    }
    if (!created) return;
    if (stale()) {
      // The request already minted a remote session before the caller
      // cancelled (end/continueInChat/dispose): it enters the bounded
      // cleanup queue so no hidden live session survives even when the
      // first DELETE is lost. `existing_consumed` reports a session this
      // request did not mint, so it is left alone.
      if (created.outcome !== "existing_consumed") {
        cleanupQueue.enqueue(parsedChatId, created.sessionId);
      }
      return;
    }

    sessionId = created.sessionId;
    chatId = parsedChatId;
    // For `existing_consumed` the true epoch is unknown; reconnect always
    // bumps it, and session.resumed is the only frame that may advance it —
    // starting at 1 keeps every honest epoch reachable and every stale one fenced.
    const initialEpoch = created.outcome === "existing_consumed" ? 1 : created.transport.epoch;
    controller = new VoiceSessionController({
      initialEpoch,
      sessionId,
      initialTurnMode: options.request.turnMode,
      onCommand: handleCommand,
    });
    unsubscribeController = controller.subscribe(emit);

    if (created.outcome === "existing_consumed") {
      // Ticket already consumed by a prior connection; only an explicit
      // authenticated reconnect may attach again (contract: reconnectRequired).
      reconnectStatus = created.status;
      injectFrame({
        type: "session.error",
        code: "session_conflict",
        retryable: true,
        recovery: "retry_connection",
      });
      setPhase("awaiting_reconnect");
      return;
    }
    if (created.transport.kind !== "relayed_websocket") {
      failSession(voiceErrorForCode("unsupported_surface"));
      return;
    }
    setPhase("active");
    transport.connect(created.transport);
  };

  const startVoice = (rawChatId: string): Promise<void> => {
    if (disposed) return Promise.reject(new VoiceSessionApiError("internal_failure"));
    if (startPromise) return startPromise;
    // Live sessions are not silently re-created; end() or reconnect() first.
    if (phase === "starting" || phase === "active" || phase === "reconnecting" || phase === "awaiting_reconnect") {
      return Promise.resolve();
    }
    const parsedChatId = VoiceCanonicalChatIdSchema.parse(rawChatId);
    const run = startFlow(parsedChatId);
    startPromise = run;
    return run.finally(() => {
      if (startPromise === run) startPromise = null;
    });
  };

  return {
    subscribe(listener) {
      if (disposed) return () => undefined;
      if (!listeners.has(listener) && listeners.size >= MAX_STATE_LISTENERS) {
        throw new RangeError(`Voice session client supports at most ${MAX_STATE_LISTENERS} listeners`);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    controller: () => controller,
    startVoice,
    async reconnect() {
      await reconnectLoop.perform(true);
    },
    retry() {
      const active = controller;
      if (active) {
        active.retry();
      } else if (unresolvedCreate) {
        void startVoice(unresolvedCreate.chatId);
      } else {
        void reconnectLoop.perform(true);
      }
    },
    retryCleanup() {
      // Explicit-only: dispose/teardown enqueues dedupe on failed keys, so
      // nothing here can become an automatic retry loop.
      return cleanupQueue.retryFailed();
    },
    continueInChat() {
      const active = controller;
      if (active && active.getState().state !== "ended") {
        active.continueInChat();
      } else {
        // No live controller: tear down locally, fence any in-flight start,
        // and mark the phase terminal before the host surface takes over.
        unresolvedCreate = null;
        void teardown(false);
        phase = "ended";
        emit();
        options.onContinueInChat?.();
      }
    },
    async end() {
      if (disposed || ending || phase === "ended") return;
      ending = true;
      unresolvedCreate = null;
      // Fence an in-flight start BEFORE tearing down: every stale() gate in
      // startFlow must see a newer generation, and a late-resolved create
      // deletes the minted remote session rather than attaching it.
      generation += 1;
      startPromise = null;
      try {
        if (controller && controller.getState().state !== "ended") {
          controller.end();
        } else {
          await teardownSession(false);
        }
        phase = "ended";
        emit();
      } finally {
        ending = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unresolvedCreate = null;
      generation += 1;
      startPromise = null;
      reconnectLoop.cancel();
      transport.retire();
      deleteRemote();
      void releaseMedia();
      unsubscribeController?.();
      unsubscribeController = null;
      controller?.dispose();
      controller = null;
      listeners.clear();
    },
  };
}

/**
 * React binding for the voice session client. The client is created once per
 * mounted hook; unmounting disposes the controller, releases the microphone,
 * and closes the socket.
 */
export function useVoiceSession(options: VoiceSessionClientOptions): VoiceSessionHook {
  const [client] = useState(() => createVoiceSessionClient(options));

  useEffect(() => () => client.dispose(), [client]);

  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);

  return {
    client,
    snapshot,
    controller: snapshot.voice === null ? null : client.controller(),
    startVoice: (chatIdForCall: string) => client.startVoice(chatIdForCall),
    reconnect: () => client.reconnect(),
    retry: () => client.retry(),
    retryCleanup: () => client.retryCleanup(),
    continueInChat: () => client.continueInChat(),
    end: () => client.end(),
  };
}

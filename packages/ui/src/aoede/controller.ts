import type { ReactNode } from "react";
import type { CanonicalChatDetailResponse, CanonicalChatApprovalView, CanonicalChatApprovalDecision, CanonicalChatInputView, CanonicalSubmitChatInputRequest, AoedeBootstrapRequest, AoedeBootstrapResponse } from "@matrix-os/contracts";
import type { SafeVoiceError } from "@matrix-os/contracts/voice-session";
import { createVoiceSessionClient } from "../voice-session/use-voice-session.js";
import { capabilityUnavailableError, type VoiceSessionClient, type VoiceSessionClientOptions } from "../voice-session/client-types.js";
import type { CanonicalChatEventSource } from "../canonical-chat-event-source.js";
import { applyCanonicalChatContent } from "../canonical-chat-content.js";
import { createAoedeApi, AoedeRequestError, type AoedeApi } from "./client.js";
import { projectAoedeCanonical, safeAoedeArtifactPath, type AoedeCanonicalProjection } from "./projection.js";
import { boundedAoedeText, type AoedeStatus } from "./presentation.js";

export interface AoedeOwnerOptions {
  identityKey: string;
  baseUrl: string;
  fetcher?: typeof fetch;
  surface: "web_canvas" | "web_desktop";
  projectId?: string;
  onOpenHistory?: (chatId: string) => void;
  onOpenResult?: (path: string) => void;
  webSocketFactory?: VoiceSessionClientOptions["webSocketFactory"];
}
export interface AoedeProviderProps extends AoedeOwnerOptions { children: ReactNode }
export interface AoedeSnapshot {
  visible: boolean;
  focusRevision: number;
  status: AoedeStatus;
  microphoneActive: boolean;
  turnMode: "hands_free" | "push_to_talk";
  binding: AoedeBootstrapResponse | null;
  canonical: AoedeCanonicalProjection;
  error: SafeVoiceError | null;
}
export function createAoedeController(owner: AoedeOwnerOptions, dependencies: { api?: AoedeApi; voiceFactory?: (options: VoiceSessionClientOptions) => VoiceSessionClient } = {}) {
  const options = { ...owner };
  const api = dependencies.api ?? createAoedeApi(options);
  const voiceFactory = dependencies.voiceFactory ?? createVoiceSessionClient;
  let snapshot: AoedeSnapshot = { visible: false, focusRevision: 0, status: "idle", microphoneActive: false, turnMode: "hands_free", binding: null, canonical: projectAoedeCanonical(null), error: null };
  // Bound subscriptions; unsubscribe and disposal are eviction. No global registry.
  const listeners: Array<() => void> = [];
  let generation = 0;
  let mediaGeneration = 0;
  let disposed = false;
  let suspended = false;
  let invoker: HTMLElement | undefined;
  let flight: Promise<void> | null = null;
  let newFlight: Promise<void> | null = null;
  let request: AoedeBootstrapRequest | null = null;
  let detail: CanonicalChatDetailResponse | null = null;
  let source: CanonicalChatEventSource | null = null;
  let media: VoiceSessionClient | null = null;
  let unsubscribeMedia: (() => void) | null = null;
  let refreshFlight: Promise<void> | null = null;
  let refreshAgain = false;
  let unavailable = false;
  const actions: Array<{ key: string; id: string; busy: boolean }> = [];
  const id = () => `req_${crypto.randomUUID().replaceAll("-", "")}`;
  const current = (epoch: number) => !disposed && !suspended && epoch === generation;
  const patch = (next: Partial<AoedeSnapshot>) => {
    if (disposed || suspended) return;
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) {
      try { listener(); } catch (error: unknown) { console.warn("[aoede] subscriber failed", error instanceof Error ? error.name : "UnknownError"); }
    }
  };
  const fail = (error: unknown) => {
    console.warn("[aoede] request failed", error instanceof Error ? error.name : "UnknownError");
    const lost = error instanceof AoedeRequestError && [403, 404, 410].includes(error.status);
    if (lost) unavailable = true;
    patch({ status: "failed", microphoneActive: false, error: { code: lost ? "chat_unavailable" : "internal_failure", retryable: !lost, recovery: lost ? "none" : "start_new_session" } });
    if (lost) { source?.dispose(); source = null; void endMedia(false); }
  };
  const acceptDetail = (value: CanonicalChatDetailResponse) => {
    if (value.record.chat.id !== snapshot.binding?.chatId || (detail && value.record.chat.revision < detail.record.chat.revision)) return;
    detail = value;
    patch({ canonical: projectAoedeCanonical(detail) });
  };
  const refresh = (): Promise<void> => {
    if (refreshFlight) { refreshAgain = true; return refreshFlight; }
    const chatId = snapshot.binding?.chatId;
    if (!chatId || unavailable || disposed) return Promise.resolve();
    const epoch = generation;
    const work = async () => {
      do {
        refreshAgain = false;
        try { const value = await api.detail(chatId); if (current(epoch)) acceptDetail(value); }
        catch (error: unknown) { if (current(epoch)) fail(error); }
      } while (refreshAgain && current(epoch) && !unavailable);
    };
    const pending = work().finally(() => { if (refreshFlight === pending) refreshFlight = null; });
    refreshFlight = pending;
    return pending;
  };
  const attach = (binding: AoedeBootstrapResponse, epoch: number, reuseMedia = false) => {
    if (!current(epoch)) return;
    if (!reuseMedia || !media) media = voiceFactory({ baseUrl: options.baseUrl, fetcher: options.fetcher, webSocketFactory: options.webSocketFactory,
      request: { turnMode: snapshot.turnMode, selection: binding.selection, interactionMode: "default", permissionMode: "supervised", memoryMode: "ordinary" } });
    const captured = media;
    unsubscribeMedia = media.subscribe(() => {
      if (!current(epoch) || captured !== media || unavailable) return;
      const value = captured.getSnapshot();
      const voice = value.voice;
      const status: AoedeStatus = value.phase === "starting" ? "connecting"
        : value.phase === "awaiting_reconnect" ? "reconnecting"
        : value.phase === "active" ? voice?.state ?? "connecting"
        : value.phase === "idle" ? snapshot.status : value.phase;
      const provisional = voice?.provisionalTranscript?.text;
      patch({ status, microphoneActive: value.phase === "active" && !!voice && !voice.muted && (voice.turnMode !== "push_to_talk" || voice.pushToTalkActive),
        error: value.error ?? value.notice ?? voice?.error ?? null,
        canonical: { ...projectAoedeCanonical(detail), ...(provisional ? { captions: { ...projectAoedeCanonical(detail).captions, utterance: boundedAoedeText(provisional), provisional: true } } : {}) } });
    });
    source = api.events();
    source.subscribe(event => {
      if (!current(epoch) || unavailable) return;
      if (event.type === "chat.changed" && event.chatId !== binding.chatId) return;
      if (event.type === "chat.changed" && event.eventType === "chat.deleted") { fail(new AoedeRequestError(410)); return; }
      if (event.type === "chat.changed" && event.content && detail) {
        const next = applyCanonicalChatContent(detail, event.content);
        if (next) { acceptDetail(next); return; }
      }
      void refresh();
    });
    void source.start().catch(error => { if (current(epoch)) fail(error); });
  };
  const bootstrap = (intent: "continue" | "new"): Promise<void> => {
    if (flight) return flight;
    if (disposed || suspended || (unavailable && intent !== "new")) return Promise.resolve();
    if (!request || request.intent !== intent) request = { clientRequestId: id(), intent, surface: options.surface, ...(options.projectId ? { projectId: options.projectId } : {}) };
    const captured = request;
    const epoch = generation;
    patch({ status: "connecting", error: null });
    const pending = (async () => {
      try {
        const binding = await api.bootstrap(captured);
        if (!current(epoch)) return;
        const previous = snapshot.binding;
        if (previous && previous.chatId !== binding.chatId) throw new AoedeRequestError(410);
        const turnMode = binding.capability.turnModes.includes(snapshot.turnMode) ? snapshot.turnMode : binding.capability.turnModes[0] ?? snapshot.turnMode;
        const changedSelection = previous && (JSON.stringify(previous.selection) !== JSON.stringify(binding.selection) || turnMode !== snapshot.turnMode);
        if (changedSelection) {
          // Backend selection is authoritative. Release the old client before binding it.
          if (!await endMedia()) return;
          unsubscribeMedia?.(); unsubscribeMedia = null; source?.dispose(); source = null;
          media?.dispose(); media = null;
          if (!current(epoch)) return;
        }
        unavailable = false; request = null;
        patch({ binding, turnMode, status: binding.capability.status === "unavailable" ? "failed" : "idle",
          error: binding.capability.status === "unavailable" ? capabilityUnavailableError(binding.capability.reason) : null });
        if (!media) attach(binding, epoch);
        await refresh();
      } catch (error: unknown) { if (current(epoch)) fail(error); }
    })().finally(() => { if (flight === pending) flight = null; });
    flight = pending;
    return pending;
  };
  async function endMedia(showEnded = true) {
    mediaGeneration += 1;
    const captured = media;
    if (showEnded) patch({ status: "ended", microphoneActive: false });
    const epoch = generation;
    try { await captured?.end(); }
    catch (error: unknown) {
      console.warn("[aoede] media cleanup unavailable", error instanceof Error ? error.name : "UnknownError");
      if (current(epoch) && !unavailable) patch({ status: "failed", microphoneActive: false, error: { code: "internal_failure", retryable: true, recovery: "start_new_session" } });
      return false;
    }
    if (current(epoch) && !unavailable && showEnded) patch({ status: "ended", microphoneActive: false });
    return true;
  }
  const mutate = async (key: string, operation: (requestId: string, chatId: string) => Promise<unknown>): Promise<boolean> => {
    const chatId = snapshot.binding?.chatId;
    if (!chatId || unavailable || disposed || suspended || newFlight) return false;
    let action = actions.find(item => item.key === key);
    if (action?.busy) return false;
    if (!action) {
      if (actions.length >= 32) {
        const evict = actions.findIndex(item => !item.busy);
        if (evict < 0) return false;
        actions.splice(evict, 1);
      }
      action = { key, id: id(), busy: false }; actions.push(action);
    }
    action.busy = true;
    const epoch = generation;
    try { await operation(action.id, chatId); if (!current(epoch)) return false; await refresh(); return current(epoch) && !unavailable; }
    catch (error: unknown) {
      if (current(epoch)) {
        if (error instanceof AoedeRequestError && error.status === 409) await refresh();
        else fail(error);
      }
      return false;
    } finally { action.busy = false; }
  };
  const controller = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { if (disposed) return () => {}; if (listeners.length >= 32) throw new RangeError("Assistant subscriber limit"); listeners.push(listener); return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); }; },
    async setSurface(surface: AoedeOwnerOptions["surface"]) {
      if (options.surface === surface || disposed || suspended) return;
      options.surface = surface;
      request = null;
      if (!snapshot.visible || unavailable) return;
      if (flight) await flight;
      // A newer presentation switch supersedes this refresh.
      if (options.surface !== surface || disposed || suspended || unavailable) return;
      request = null;
      await bootstrap("continue");
    },
    async open(target?: HTMLElement) { if (disposed || suspended) return; if (target) invoker = target; patch({ visible: true, focusRevision: (snapshot.focusRevision + 1) % 2_147_483_647 }); if (!snapshot.binding && !unavailable) await bootstrap(request?.intent ?? "continue"); },
    async focus(target?: HTMLElement) { await controller.open(target); },
    async toggle(target?: HTMLElement) { if (snapshot.visible) await controller.dismiss(); else await controller.open(target); },
    async dismiss() { patch({ visible: false }); await endMedia(); if (!disposed && !suspended && !snapshot.visible && invoker?.isConnected) invoker.focus(); },
    end: () => endMedia(),
    async start() {
      if (disposed || suspended || newFlight || unavailable || !snapshot.binding || !media || !snapshot.visible) return;
      if (snapshot.binding.capability.status === "unavailable" || !snapshot.binding.capability.turnModes.includes(snapshot.turnMode)) return;
      if (!["idle", "ended", "permission", "failed"].includes(snapshot.status)) return;
      if (snapshot.status !== "permission") { patch({ status: "permission", error: null }); return; }
      const epoch = generation; const mediaEpoch = ++mediaGeneration; const captured = media; const chatId = snapshot.binding.chatId;
      patch({ status: "connecting" });
      try {
        if (captured.getSnapshot().phase === "awaiting_reconnect") await captured.reconnect();
        else await captured.startVoice(chatId);
        if (!current(epoch) || mediaEpoch !== mediaGeneration) await captured.end();
      }
      catch (error: unknown) { if (current(epoch) && mediaEpoch === mediaGeneration) fail(error); }
    },
    async newConversation() {
      if (newFlight || disposed) return newFlight ?? Promise.resolve();
      const pending = (async () => {
        // Fence all old detail/permission/bootstrap work before releasing resources.
        generation += 1; flight = null; refreshFlight = null; refreshAgain = false;
        source?.dispose(); source = null; unsubscribeMedia?.(); unsubscribeMedia = null;
        if (!await endMedia()) {
          if (snapshot.binding && !unavailable) attach(snapshot.binding, generation, true);
          return;
        }
        media?.dispose(); media = null; detail = null; actions.length = 0;
        if (disposed) return;
        unavailable = false; patch({ binding: null, canonical: projectAoedeCanonical(null) });
        await bootstrap("new");
      })().finally(() => { if (newFlight === pending) newFlight = null; });
      newFlight = pending; return pending;
    },
    async retry() {
      if (unavailable || disposed || suspended) return;
      if (["listening", "speaking", "thinking", "using_tool", "paused"].includes(snapshot.status)) return;
      await bootstrap(request?.intent ?? "continue");
      if (!unavailable && snapshot.binding?.capability.status !== "unavailable" && snapshot.status !== "failed") patch({ status: "permission", error: null, microphoneActive: false });
    },
    pause() { media?.controller()?.pause(); }, resume() { if (!unavailable) media?.controller()?.resume(); },
    stopSpeaking() { media?.controller()?.stopSpeaking(); },
    pushToTalkStart() { media?.controller()?.beginPushToTalk(); }, pushToTalkStop() { media?.controller()?.endPushToTalk(); },
    cancelGeneration() {
      const canonical = snapshot.canonical;
      if (!canonical.canCancel || !canonical.runId) return Promise.resolve(false);
      const runId = canonical.runId;
      return mutate(`cancel:${runId}`, (clientRequestId, chatId) => api.cancelRun(chatId, runId, { clientRequestId }));
    },
    submitApproval(view: CanonicalChatApprovalView, decision: CanonicalChatApprovalDecision) {
      const live = snapshot.canonical.approvals.find(item => item.runId === view.runId && item.approvalId === view.approvalId);
      if (!live?.pending || live.runId !== snapshot.canonical.runId || !live.argumentDigest || live.argumentDigest !== view.argumentDigest || !live.allowedDecisions.includes(decision)) { void refresh(); return Promise.resolve(false); }
      return mutate(`approval:${view.runId}:${view.approvalId}:${live.argumentDigest}:${decision}`, (clientRequestId, chatId) => api.submitApproval(chatId, view.runId, view.approvalId, { clientRequestId, decision, argumentDigest: live.argumentDigest }));
    },
    submitInput(view: CanonicalChatInputView, answer: Omit<CanonicalSubmitChatInputRequest, "clientRequestId">) {
      const live = snapshot.canonical.inputs.find(item => item.runId === view.runId && item.requestId === view.requestId);
      if (!live?.pending || live.runId !== snapshot.canonical.runId || live.id !== view.id || JSON.stringify(live.questions) !== JSON.stringify(view.questions)) { void refresh(); return Promise.resolve(false); }
      return mutate(`input:${view.runId}:${view.requestId}`, (clientRequestId, chatId) => api.submitInput(chatId, view.runId, view.requestId, { ...answer, clientRequestId }));
    },
    viewHistory() { if (snapshot.binding && !unavailable) options.onOpenHistory?.(snapshot.binding.chatId); },
    openResult(path: string) { const safe = safeAoedeArtifactPath(path); if (safe && snapshot.canonical.artifacts.some(item => item.path === safe)) options.onOpenResult?.(safe); },
    refresh,
    /** React owner lease: fence identity immediately, defer only irreversible disposal. */
    suspend() {
      if (disposed || suspended) return;
      suspended = true; mediaGeneration += 1;
      void media?.end().catch(error => console.warn("[aoede] suspended cleanup failed", error instanceof Error ? error.name : "UnknownError"));
    },
    activate() { if (!disposed) suspended = false; },
    dispose() {
      if (disposed) return;
      generation += 1; mediaGeneration += 1; disposed = true;
      source?.dispose(); source = null; unsubscribeMedia?.(); unsubscribeMedia = null;
      const captured = media; media = null;
      void captured?.end().catch(error => console.warn("[aoede] cleanup failed", error instanceof Error ? error.name : "UnknownError")).finally(() => captured.dispose());
      listeners.length = 0; actions.length = 0; invoker = undefined;
      snapshot = { ...snapshot, visible: false, microphoneActive: false, status: "ended" };
    },
  };
  return controller;
}
export type AoedeController = ReturnType<typeof createAoedeController>;

import type { ReactNode } from "react";
import { CanonicalActionIdSchema, type CanonicalChatDetailResponse, type CanonicalChatApprovalView, type CanonicalChatApprovalDecision, type CanonicalChatInputView, type CanonicalSubmitChatInputRequest, type CanonicalChatModelSelection, type CanonicalChatRecord, type CanonicalUpdateChatSelectionRequest, type CanonicalChatActionCancellationResponse, type CanonicalProviderCatalog, type AoedeBootstrapRequest, type AoedeBootstrapResponse } from "@matrix-os/contracts";
import type { SafeVoiceError } from "@matrix-os/contracts/voice-session";
import { createVoiceSessionClient } from "../voice-session/use-voice-session.js";
import { capabilityUnavailableError, type VoiceSessionClient, type VoiceSessionClientOptions, type VoiceSessionDevice } from "../voice-session/client-types.js";
import { voiceErrorForCode, VoiceSessionApiError } from "../voice-session/session-api.js";
import type { CanonicalChatEventSource } from "../canonical-chat-event-source.js";
import { applyCanonicalChatContent } from "../canonical-chat-content.js";
import { createAoedeApi, AoedeRequestError, type AoedeApi } from "./client.js";
import { isCancellableOperation, projectAoedeCanonical, safeAoedeArtifactPath, type AoedeCanonicalProjection } from "./projection.js";
import { boundedAoedeText, type AoedeStatus } from "./presentation.js";
import { AoedeSpeechLanguageSchema, loadAoedePreferences, saveAoedePreferences, type AoedePreferences, type AoedeSpeechLanguage } from "./preferences.js";

/** Installed apps live under `apps/<slug>`; canonical navigation may only target that space. */
const SAFE_NAV_APP = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const NAV_PATH_MAX = 160;
const NAV_PATH_FORBIDDEN = /[\\%?#:\x00-\x1f]/;
const AUTO_NAV_OPERATION_LIMIT = 256;
/** Voice wire-format device ids (SAFE_ID_BODY, bounded). */
const DEVICE_ID_SAFE = /^[A-Za-z0-9_-]{1,256}$/;

export interface AoedeOwnerOptions {
  identityKey: string;
  baseUrl: string;
  fetcher?: typeof fetch;
  surface: "web_canvas" | "web_desktop";
  projectId?: string;
  onOpenHistory?: (chatId: string) => void;
  onOpenResult?: (path: string) => void;
  /** Validated canonical navigation into installed app windows (`apps/<slug>` only). */
  onOpenNavigation?: (nav: { kind?: "open_app" | "close_app"; app: string; path: string }) => void;
  webSocketFactory?: VoiceSessionClientOptions["webSocketFactory"];
}
export interface AoedeProviderProps extends AoedeOwnerOptions { children: ReactNode }
/**
 * Canonical selection/cancellation surface the controller consumes. Optional on
 * `AoedeControllerApi` so the controller degrades truthfully (null/false) while
 * an older client build lacks them — never silent, never an unhandled throw.
 */
export interface AoedeSelectionApi {
  providers(): Promise<CanonicalProviderCatalog>;
  updateSelection(chatId: string, input: CanonicalUpdateChatSelectionRequest): Promise<CanonicalChatRecord>;
  cancelAction(chatId: string, actionId: string): Promise<CanonicalChatActionCancellationResponse>;
}
export type AoedeControllerApi = AoedeApi & Partial<AoedeSelectionApi>;

export interface AoedeSnapshot {
  visible: boolean;
  focusRevision: number;
  status: AoedeStatus;
  microphoneActive: boolean;
  turnMode: "hands_free" | "push_to_talk";
  preferredLanguage: AoedeSpeechLanguage;
  /** Persisted capture device; null = system default. */
  inputDeviceId: string | null;
  /** Persisted playback device; null = system default. */
  outputDeviceId: string | null;
  /** Bumped whenever a re-enumeration settles so settings can refresh its list. */
  devicesRevision: number;
  binding: AoedeBootstrapResponse | null;
  /** Immutable provider instance once a run bound the Chat (selection stays inside it). */
  boundProviderInstanceId: string | null;
  /** Truthful outcome of the most recent targeted action cancellation. */
  lastActionCancelOutcome: "cancelled" | "requested" | "already_terminal" | "unknown" | null;
  canonical: AoedeCanonicalProjection;
  error: SafeVoiceError | null;
}
export function createAoedeController(owner: AoedeOwnerOptions, dependencies: { api?: AoedeControllerApi; voiceFactory?: (options: VoiceSessionClientOptions) => VoiceSessionClient } = {}) {
  const options = { ...owner };
  const api: AoedeControllerApi = dependencies.api ?? createAoedeApi(options);
  const voiceFactory = dependencies.voiceFactory ?? createVoiceSessionClient;
  let prefs: AoedePreferences = loadAoedePreferences();
  let snapshot: AoedeSnapshot = {
    visible: false, focusRevision: 0, status: "idle", microphoneActive: false,
    turnMode: prefs.turnMode ?? "hands_free",
    preferredLanguage: prefs.preferredLanguage ?? "en",
    inputDeviceId: prefs.inputDeviceId ?? null,
    outputDeviceId: prefs.outputDeviceId ?? null,
    devicesRevision: 0,
    binding: null, boundProviderInstanceId: null, lastActionCancelOutcome: null,
    canonical: projectAoedeCanonical(null), error: null,
  };
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
  const levelListeners = new Set<(level: number) => void>();
  let unsubscribeMedia: (() => void) | null = null;
  let refreshFlight: Promise<void> | null = null;
  let refreshAgain = false;
  let requestError: SafeVoiceError | null = null;
  let unavailable = false;
  let providerCatalog: CanonicalProviderCatalog | null = null;
  let providerFlight: Promise<CanonicalProviderCatalog | null> | null = null;
  let deviceEnumerationRevision = 0;
  const actions: Array<{ key: string; id: string; busy: boolean }> = [];
  const autoNavigatedOperations = new Set<string>();
  let autoNavigationBaselineReady = false;
  const id = () => `req_${crypto.randomUUID().replaceAll("-", "")}`;
  /** Preference writes are merge-only and never throw (storage may be absent). */
  const persistPrefs = (next: Partial<AoedePreferences>) => {
    prefs = { ...prefs, ...next };
    saveAoedePreferences(prefs);
  };
  const normalizeDeviceId = (value: string | null): string | null | undefined => {
    if (value === null) return null;
    return DEVICE_ID_SAFE.test(value) ? value : undefined;
  };
  const current = (epoch: number) => !disposed && !suspended && epoch === generation;
  const patch = (next: Partial<AoedeSnapshot>) => {
    if (disposed || suspended) return;
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) {
      try { listener(); } catch (error: unknown) { console.warn("[aoede] subscriber failed", error instanceof Error ? error.name : "UnknownError"); }
    }
  };
  const projectedMediaError = (value: ReturnType<VoiceSessionClient["getSnapshot"]> | undefined): SafeVoiceError | null => {
    if (!value) return null;
    const error = value.error ?? value.notice ?? value.voice?.error;
    // Retryable media warnings describe an interruption, not a live session
    // that has already continued. The media snapshot is authoritative: retain
    // warnings for paused/terminal states, but do not leave one stale while a
    // normal active state is progressing.
    const continuing = value.phase === "active" && value.voice
      && ["listening", "thinking", "using_tool", "speaking"].includes(value.voice.state);
    return error?.retryable && continuing ? null : (error ?? null);
  };
  const fail = (error: unknown) => {
    console.warn("[aoede] request failed", error instanceof Error ? error.name : "UnknownError");
    const lost = error instanceof AoedeRequestError && [403, 404, 410].includes(error.status);
    if (lost) unavailable = true;
    // A safe voice error (permission_denied, input_unavailable…) is already
    // truthful — surface it instead of collapsing to a generic failure.
    const safe = error instanceof VoiceSessionApiError ? error.safeError
      : error instanceof AoedeRequestError ? error.safeError
      : error instanceof Error && error.name === "TimeoutError" ? voiceErrorForCode("connection_failed") : undefined;
    requestError = lost
      ? { code: "chat_unavailable", retryable: false, recovery: "none" }
      : (safe ?? { code: "internal_failure", retryable: true, recovery: "start_new_session" });
    // A failed Chat request does not stop media. Preserve its live projection.
    patch({ ...(!lost && mediaLive() ? {} : { status: "failed", microphoneActive: false }), error: requestError });
    if (lost) { source?.dispose(); source = null; void endMedia(false); }
  };
  const dispatchNavigation = (nav: { kind: "open_app" | "close_app"; app: string; path: string }) => {
    const app = typeof nav?.app === "string" ? nav.app : "";
    const path = typeof nav?.path === "string" ? nav.path : "";
    if (!SAFE_NAV_APP.test(app) || path.length === 0 || path.length > NAV_PATH_MAX) return;
    if (path.includes("..") || path.includes("//") || NAV_PATH_FORBIDDEN.test(path)) return;
    const prefix = `apps/${app}`;
    if (path !== prefix && path !== `${prefix}.html` && !path.startsWith(`${prefix}/`)) return;
    options.onOpenNavigation?.({ ...(nav.kind === "close_app" ? { kind: nav.kind } : {}), app, path });
  };
  const acceptDetail = (value: CanonicalChatDetailResponse) => {
    if (value.record.chat.id !== snapshot.binding?.chatId || (detail && value.record.chat.revision < detail.record.chat.revision)) return;
    const navigations = (value.operations ?? []).filter(operation => operation.state === "succeeded" && operation.result?.navigation);
    if (!autoNavigationBaselineReady) {
      for (const operation of navigations) {
        if (autoNavigatedOperations.size < AUTO_NAV_OPERATION_LIMIT) autoNavigatedOperations.add(operation.id);
      }
      autoNavigationBaselineReady = true;
    } else {
      for (const operation of navigations) {
        if (autoNavigatedOperations.has(operation.id)) continue;
        // Fail closed once the bounded deduplication ledger is full: dispatching
        // without remembering could replay navigation on every later refresh.
        if (autoNavigatedOperations.size >= AUTO_NAV_OPERATION_LIMIT) continue;
        autoNavigatedOperations.add(operation.id);
        if (snapshot.visible && !suspended) dispatchNavigation(operation.result!.navigation!);
      }
    }
    detail = value;
    const recovered = requestError !== null;
    requestError = null;
    const live = media?.getSnapshot();
    const capability = snapshot.binding?.capability;
    const readinessError = capability?.status === "unavailable" ? capabilityUnavailableError(capability.reason) : null;
    const error = projectedMediaError(live) ?? readinessError;
    patch({ canonical: projectAoedeCanonical(detail), boundProviderInstanceId: value.record.providerBinding?.instanceId ?? null,
      ...(recovered ? { error,
        ...(!error && snapshot.status === "failed" && !mediaLive() ? { status: live?.phase === "ended" ? "ended" as const : "idle" as const } : {}),
      } : {}) });
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
        catch (error: unknown) {
          if (!current(epoch)) continue;
          const transient = error instanceof AoedeRequestError
            ? error.status === 408 || error.status === 429 || error.status >= 500
            : error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
          // A passive Chat read cannot establish that live voice has failed.
          // Retain confirmed content; later events still refresh it normally.
          // Access loss, explicit actions and media errors keep their own paths.
          if (transient && mediaLive()) console.warn("[aoede] canonical refresh delayed", error instanceof Error ? error.name : "UnknownError");
          else fail(error);
        }
      } while (refreshAgain && current(epoch) && !unavailable);
    };
    const pending = work().finally(() => { if (refreshFlight === pending) refreshFlight = null; });
    refreshFlight = pending;
    return pending;
  };
  const attach = (binding: AoedeBootstrapResponse, epoch: number, reuseMedia = false) => {
    if (!current(epoch)) return;
    if (!reuseMedia || !media) {
      const created = voiceFactory({ baseUrl: options.baseUrl, fetcher: options.fetcher, webSocketFactory: options.webSocketFactory,
        request: { turnMode: snapshot.turnMode, selection: binding.selection, interactionMode: "default", permissionMode: "supervised", memoryMode: "ordinary",
          ...(snapshot.preferredLanguage === "auto" ? {} : { locale: snapshot.preferredLanguage }),
          ...(snapshot.inputDeviceId ? { inputDeviceId: snapshot.inputDeviceId } : {}),
          ...(snapshot.outputDeviceId ? { outputDeviceId: snapshot.outputDeviceId } : {}) } });
      media = created;
      // Presentation-only loudness; fenced to the media client that produced it.
      created.subscribeInputLevel?.((level) => {
        if (created !== media || unavailable) return;
        for (const listener of levelListeners) listener(level);
      });
    }
    const captured = media;
    unsubscribeMedia = media.subscribe(() => {
      if (!current(epoch) || captured !== media || unavailable) return;
      const value = captured.getSnapshot();
      const voice = value.voice;
      // awaiting_reconnect means a live server-side session is being restored
      // onto a fresh transport — restoring, distinct from a retry loop.
      const status: AoedeStatus = value.phase === "starting" ? "connecting"
        : value.phase === "awaiting_reconnect" ? "restoring"
        : value.phase === "active" ? voice?.state ?? "connecting"
        : value.phase === "idle" ? snapshot.status : value.phase;
      const provisional = voice?.provisionalTranscript?.text;
      patch({ status, microphoneActive: value.phase === "active" && !!voice && !voice.muted && (voice.turnMode !== "push_to_talk" || voice.pushToTalkActive),
        error: projectedMediaError(value) ?? requestError,
        canonical: { ...projectAoedeCanonical(detail), ...(provisional ? { captions: { ...projectAoedeCanonical(detail).captions, utterance: boundedAoedeText(provisional), provisional: true } } : {}) } });
    });
    source = api.events();
    source.subscribe(event => {
      if (!current(epoch) || unavailable) return;
      if (event.type === "chat.changed" && event.chatId !== binding.chatId) return;
      if (event.type === "chat.changed" && event.eventType === "chat.deleted") { fail(new AoedeRequestError(410)); return; }
      if (event.type === "chat.changed" && event.content && detail) {
        const next = applyCanonicalChatContent(detail, event.content);
        // Content frames never carry operations. Discover new/changed actions
        // on activity and lifecycle events, without refetching for text deltas.
        if (next) { acceptDetail(next); if (event.eventType === "run.message") return; }
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
        let binding: AoedeBootstrapResponse;
        try { binding = await api.bootstrap(captured); }
        catch (error: unknown) {
          // A cold gateway can exceed the first request window while it probes
          // providers. The request is idempotent by clientRequestId, so one
          // immediate retry joins that work instead of reporting a failure.
          if (!(error instanceof Error && error.name === "TimeoutError") || !current(epoch)) throw error;
          console.warn("[aoede] bootstrap timed out; retrying once");
          binding = await api.bootstrap(captured);
        }
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
        unavailable = false; request = null; requestError = null;
        patch({ binding, turnMode, status: binding.capability.status === "unavailable" ? "failed" : "idle",
          error: binding.capability.status === "unavailable" ? capabilityUnavailableError(binding.capability.reason) : null });
        if (!media) attach(binding, epoch);
        await refresh();
      } catch (error: unknown) { if (current(epoch)) fail(error); }
    })().finally(() => { if (flight === pending) flight = null; });
    flight = pending;
    return pending;
  };
  /** True while the media owner still holds a live or in-flight session. */
  const mediaLive = () => media !== null && !["idle", "ended", "failed"].includes(media.getSnapshot().phase);
  async function endMedia(showEnded = true) {
    mediaGeneration += 1;
    const captured = media;
    // A live session shows the explicit end-in-progress literal; anything
    // without live media settles straight to "ended" — never inferred.
    const live = captured !== null && !["idle", "ended", "failed"].includes(captured.getSnapshot().phase);
    if (showEnded) patch({ status: live ? "ending" : "ended", microphoneActive: false });
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
  /**
   * Ends the frozen media owner and re-attaches (fresh source + client) so the
   * next Start builds against the persisted config — the surface-switch
   * semantics used for backend-driven selection changes.
   */
  const rebuildMediaOwner = async (epoch: number): Promise<boolean> => {
    if (!await endMedia(mediaLive())) return false;
    unsubscribeMedia?.(); unsubscribeMedia = null;
    source?.dispose(); source = null;
    media?.dispose(); media = null;
    const binding = snapshot.binding;
    if (!binding || !current(epoch)) return false;
    attach(binding, epoch);
    return true;
  };
  /** Re-enumerate after devicechange: refresh the list and reconcile stale prefs. */
  const refreshDeviceLists = async () => {
    if (typeof media?.listDevices !== "function") return;
    const epoch = generation;
    const revision = ++deviceEnumerationRevision;
    const selectedInput = snapshot.inputDeviceId;
    const selectedOutput = snapshot.outputDeviceId;
    const list = await media.listDevices();
    if (!current(epoch) || revision !== deviceEnumerationRevision || list === null
      || snapshot.inputDeviceId !== selectedInput || snapshot.outputDeviceId !== selectedOutput) return;
    const next: Partial<AoedeSnapshot> = { devicesRevision: snapshot.devicesRevision + 1 };
    const missingInput = selectedInput !== null
      && !list.some((device) => device.kind === "audioinput" && device.deviceId === selectedInput);
    const missingOutput = selectedOutput !== null
      && !list.some((device) => device.kind === "audiooutput" && device.deviceId === selectedOutput);
    if (missingInput || missingOutput) {
      // Release capture and playback before changing preferences. Calling the
      // device setters with null would hot-swap to defaults and silently resume.
      if (!await endMedia(false)) return;
      if (!current(epoch) || revision !== deviceEnumerationRevision
        || snapshot.inputDeviceId !== selectedInput || snapshot.outputDeviceId !== selectedOutput) return;
    }
    if (missingInput) {
      persistPrefs({ inputDeviceId: null });
      next.inputDeviceId = null;
      next.status = "failed";
      next.microphoneActive = false;
      next.error = voiceErrorForCode("input_unavailable");
    }
    if (missingOutput) {
      persistPrefs({ outputDeviceId: null });
      next.outputDeviceId = null;
      next.status = "failed";
      next.microphoneActive = false;
      if (!missingInput) next.error = voiceErrorForCode("output_unavailable");
    }
    patch(next);
  };
  const browserMediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  const onBrowserDeviceChange = () => { void refreshDeviceLists(); };
  if (browserMediaDevices && typeof browserMediaDevices.addEventListener === "function") {
    browserMediaDevices.addEventListener("devicechange", onBrowserDeviceChange);
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
    /** Capture loudness (0…1) for the presence orb; bypasses React state. */
    subscribeInputLevel(listener: (level: number) => void) {
      if (disposed) return () => {};
      if (!levelListeners.has(listener) && levelListeners.size >= 32) throw new RangeError("Assistant level subscriber limit");
      levelListeners.add(listener);
      return () => { levelListeners.delete(listener); };
    },
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
    async open(target?: HTMLElement) { if (disposed || suspended) return; if (target) invoker = target; patch({ visible: true, focusRevision: (snapshot.focusRevision + 1) % 2_147_483_647 }); if (!snapshot.binding && !unavailable) await bootstrap(request?.intent ?? "new"); },
    async focus(target?: HTMLElement) { await controller.open(target); },
    async toggle(target?: HTMLElement) { if (snapshot.visible) await controller.dismiss(); else await controller.open(target); },
    async dismiss() { patch({ visible: false }); await endMedia(); if (!disposed && !suspended && !snapshot.visible && invoker?.isConnected) invoker.focus(); },
    end: () => endMedia(),
    async start() {
      if (disposed || suspended || newFlight || unavailable || !snapshot.binding || !media || !snapshot.visible) return;
      if (snapshot.binding.capability.status !== "available" || !snapshot.binding.capability.turnModes.includes(snapshot.turnMode)) return;
      if (!["idle", "ended", "permission", "failed"].includes(snapshot.status)) return;
      // One gesture: Start requests the microphone directly. The browser's own
      // permission prompt is the consent step; no interstitial confirmation.
      const epoch = generation; const mediaEpoch = ++mediaGeneration; const captured = media; const chatId = snapshot.binding.chatId;
      patch({ status: "connecting", error: null });
      try {
        // A vanished explicit device requires recovery; never fall back to the
        // system default or start capture without a new user choice.
        if (snapshot.inputDeviceId && typeof captured.listDevices === "function") {
          const selectedInput = snapshot.inputDeviceId;
          const list = await captured.listDevices();
          if (!current(epoch) || mediaEpoch !== mediaGeneration) return;
          if (list !== null && !list.some((device) => device.kind === "audioinput" && device.deviceId === selectedInput)) {
            await captured.end();
            if (!current(epoch) || snapshot.inputDeviceId !== selectedInput) return;
            persistPrefs({ inputDeviceId: null });
            patch({ inputDeviceId: null, status: "failed", microphoneActive: false,
              error: voiceErrorForCode("input_unavailable") });
            return;
          }
        }
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
        autoNavigatedOperations.clear(); autoNavigationBaselineReady = false;
        if (disposed) return;
        unavailable = false;
        patch({ binding: null, boundProviderInstanceId: null, lastActionCancelOutcome: null, canonical: projectAoedeCanonical(null) });
        await bootstrap("new");
      })().finally(() => { if (newFlight === pending) newFlight = null; });
      newFlight = pending; return pending;
    },
    async retry() {
      if (unavailable || disposed || suspended) return;
      if (["listening", "speaking", "thinking", "using_tool", "paused", "restoring", "ending"].includes(snapshot.status)) return;
      providerCatalog = null; // refetch the catalog on the next listProviders
      await bootstrap(request?.intent ?? "continue");
      if (!unavailable && snapshot.binding?.capability.status !== "unavailable" && snapshot.status !== "failed") patch({ status: "idle", error: null, microphoneActive: false });
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
    openResult(path: string) { const safe = safeAoedeArtifactPath(path); if (safe && (snapshot.canonical.artifacts.some(item => item.path === safe) || snapshot.canonical.actionArtifacts.includes(safe))) options.onOpenResult?.(safe); },
    /** Canonical navigation into installed app windows; unsafe destinations never reach the host. */
    openNavigation(nav: { app: string; path: string }) {
      dispatchNavigation({ kind: "open_app", ...nav });
    },
    /** Provider catalog for Settings. Cached per controller; retry() refetches. */
    listProviders(): Promise<CanonicalProviderCatalog | null> {
      if (providerCatalog) return Promise.resolve(providerCatalog);
      if (providerFlight) return providerFlight;
      if (typeof api.providers !== "function" || unavailable || disposed || suspended) return Promise.resolve(null);
      const epoch = generation;
      const work = async () => {
        try {
          const catalog = await api.providers!();
          if (!current(epoch)) return null;
          providerCatalog = catalog;
          return catalog;
        } catch (error: unknown) {
          if (current(epoch)) console.warn("[aoede] provider catalog unavailable", error instanceof Error ? error.name : "UnknownError");
          return null;
        }
      };
      const pending = work().finally(() => { if (providerFlight === pending) providerFlight = null; });
      providerFlight = pending;
      return pending;
    },
    /**
     * Revision-fenced canonical selection update. The canonical record stays
     * authoritative — the response record re-resolves binding.selection and the
     * frozen media owner is rebuilt so the next Start uses the new selection.
     */
    setSelection(selection: CanonicalChatModelSelection): Promise<boolean> {
      const baseRevision = detail?.record.chat.revision;
      if (!snapshot.binding || baseRevision === undefined || typeof api.updateSelection !== "function") return Promise.resolve(false);
      const epoch = generation;
      const changed = mutate("selection", (_requestId, chatId) => api.updateSelection!(chatId, { baseRevision, selection }));
      return changed.then(async (ok) => {
        if (!ok || !current(epoch)) return false;
        const resolved = detail?.record.chat.currentSelection;
        if (resolved && snapshot.binding) {
          patch({ binding: { ...snapshot.binding, selection: resolved } });
        }
        if (!await rebuildMediaOwner(epoch)) return false;
        await bootstrap("continue");
        return current(epoch);
      });
    },
    /** Persisted turn mode. A live session ends so the next Start applies it. */
    async setTurnMode(mode: "hands_free" | "push_to_talk") {
      if (disposed || suspended) return;
      if (mode !== "hands_free" && mode !== "push_to_talk") return;
      const supported = snapshot.binding?.capability.turnModes;
      if (supported && !supported.includes(mode)) return;
      persistPrefs({ turnMode: mode });
      patch({ turnMode: mode });
      if (!media || !snapshot.binding) return;
      await rebuildMediaOwner(generation);
    },
    /** Never change recognition language halfway through a captured turn. */
    async setPreferredLanguage(language: string) {
      if (disposed || suspended) return;
      const parsed = AoedeSpeechLanguageSchema.safeParse(language);
      if (!parsed.success || parsed.data === snapshot.preferredLanguage) return;
      persistPrefs({ preferredLanguage: parsed.data });
      patch({ preferredLanguage: parsed.data });
      if (media && snapshot.binding) await rebuildMediaOwner(generation);
    },
    listDevices(): Promise<VoiceSessionDevice[] | null> {
      if (disposed) return Promise.resolve(null);
      return media?.listDevices?.() ?? Promise.resolve(null);
    },
    async setInputDevice(deviceId: string | null): Promise<boolean> {
      const normalized = normalizeDeviceId(deviceId);
      if (normalized === undefined) return false;
      deviceEnumerationRevision += 1;
      persistPrefs({ inputDeviceId: normalized });
      patch({ inputDeviceId: normalized });
      if (typeof media?.setInputDevice !== "function") return true;
      return media.setInputDevice(normalized);
    },
    async setOutputDevice(deviceId: string | null): Promise<"applied" | "unsupported" | "unavailable"> {
      const normalized = normalizeDeviceId(deviceId);
      if (normalized === undefined) return "unavailable";
      deviceEnumerationRevision += 1;
      persistPrefs({ outputDeviceId: normalized });
      patch({ outputDeviceId: normalized });
      if (typeof media?.setOutputDevice !== "function") return "applied";
      return media.setOutputDevice(normalized);
    },
    /**
     * Targeted canonical action cancellation. Runs under per-action mutate
     * fencing, returns the truthful outcome, and merges the authority's
     * operation view into the local detail.
     */
    cancelAction(actionId: string): Promise<"cancelled" | "requested" | "already_terminal" | "unknown" | null> {
      const parsed = CanonicalActionIdSchema.safeParse(actionId);
      if (!parsed.success || unavailable || disposed || suspended || typeof api.cancelAction !== "function") return Promise.resolve(null);
      const operation = detail?.operations?.find((item) => item.id === parsed.data);
      if (!operation || !isCancellableOperation(operation) || operation.chatId !== snapshot.binding?.chatId) return Promise.resolve(null);
      const actionKey = parsed.data;
      let outcome: "cancelled" | "requested" | "already_terminal" | "unknown" | null = null;
      const epoch = generation;
      return mutate(`action_cancel_${actionKey}`, (_requestId, chatId) =>
        api.cancelAction!(chatId, actionKey).then((response: CanonicalChatActionCancellationResponse) => {
          outcome = response.cancellation;
          if (detail?.operations) {
            detail = { ...detail, operations: detail.operations.map((item) => item.id === response.operation.id ? response.operation : item) };
            patch({ canonical: projectAoedeCanonical(detail) });
          }
        })).then((ok) => {
          if (!ok || !current(epoch)) return null;
          patch({ lastActionCancelOutcome: outcome });
          return outcome;
        });
    },
    refresh,
    /** React owner lease: fence identity immediately, defer only irreversible disposal. */
    suspend() {
      if (disposed || suspended) return;
      mediaGeneration += 1;
      // patch() is a no-op while suspended — record the teardown first so a
      // later activate() never replays a stale live status.
      patch({ microphoneActive: false,
        status: ["idle", "ended", "failed"].includes(snapshot.status) ? snapshot.status : "ended" });
      // Treat the first post-activation detail as a reconnect baseline. Results
      // completed while this controller did not own observation must not replay.
      autoNavigationBaselineReady = false;
      suspended = true;
      void media?.end().catch(error => console.warn("[aoede] suspended cleanup failed", error instanceof Error ? error.name : "UnknownError"));
    },
    activate() { if (disposed || !suspended) return; suspended = false; patch({}); },
    dispose() {
      if (disposed) return;
      generation += 1; mediaGeneration += 1; disposed = true;
      browserMediaDevices?.removeEventListener?.("devicechange", onBrowserDeviceChange);
      source?.dispose(); source = null; unsubscribeMedia?.(); unsubscribeMedia = null;
      const captured = media; media = null;
      void captured?.end().catch(error => console.warn("[aoede] cleanup failed", error instanceof Error ? error.name : "UnknownError")).finally(() => captured.dispose());
      listeners.length = 0; levelListeners.clear(); actions.length = 0; invoker = undefined;
      snapshot = { ...snapshot, visible: false, microphoneActive: false, status: "ended" };
    },
  };
  return controller;
}
export type AoedeController = ReturnType<typeof createAoedeController>;

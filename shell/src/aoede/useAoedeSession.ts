"use client";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { AoedeReadinessSchema, AoedeServerMessageSchema, type AoedeReadiness, type AoedeCard, type AoedeClientMessage, type AoedeServerMessage } from "@matrix-os/contracts";
import { useSocket } from "@/hooks/useSocket";
import { getGatewayUrl } from "@/lib/gateway";
import { createCanonicalShellChatClient } from "@/lib/canonical-chat-client";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "@/lib/canonical-provider-setup";
import { AoedeMedia, type CaptionEvent } from "./media";
import type { UiResult } from "./shell-actions";

type State = { status: "idle" | "connecting" | "active" | "closed" | "interrupted" | "superseded" | "error" | "denied" | "caption_limit";
  readiness: AoedeReadiness | { status: "checking"; message: string }; muted: boolean;
  taskErrors: Extract<AoedeServerMessage, { type: "aoede:task_error" }>[];
  recoveryError: boolean;
  captions: { id: number; role: "user" | "assistant"; text: string; start: number; end: number }[]; cards: AoedeCard[]; actionError: boolean; deciding: string[]; captioning: boolean };
const initial: State = { status: "idle", readiness: { status: "checking", message: "Checking execution access…" }, muted: false, taskErrors: [], recoveryError: false, captions: [], cards: [], actionError: false, deciding: [], captioning: false };
const readinessUnavailable: AoedeReadiness = { status: "error", message: "Execution access could not be checked. Recheck access or check Settings before requesting work." };
type Update = { status: State["status"] } | { readiness: State["readiness"] } | { muted: boolean } | { recoveryError: boolean } | { taskError: State["taskErrors"][number] } | { caption: CaptionEvent } | { card: AoedeCard } | { actionError: boolean } | { deciding: string; finished?: boolean } | { captioning: false };
function reducer(state: State, update: Update): State {
  if ("readiness" in update) return { ...state, readiness: update.readiness };
  if ("muted" in update) return { ...state, muted: update.muted };
  if ("recoveryError" in update) return { ...state, recoveryError: update.recoveryError };
  if ("taskError" in update) return { ...state, taskErrors: [...state.taskErrors, update.taskError].slice(-12) };
  if ("status" in update) return update.status === "connecting" ? { ...initial, readiness: state.readiness, recoveryError: state.recoveryError, status: update.status } : { ...state, status: update.status, muted: update.status === "active" && state.muted, captioning: false };
  if ("captioning" in update) return { ...state, captioning: false };
  if ("actionError" in update) return { ...state, actionError: update.actionError };
  if ("deciding" in update) return { ...state, deciding: update.finished ? state.deciding.filter((id) => id !== update.deciding) : [...state.deciding, update.deciding].slice(-100) };
  if ("card" in update) return { ...state, cards: [...state.cards.filter((c) => c.id !== update.card.id), update.card].slice(-12) };
  const event = update.caption;
  if (typeof event.delta !== "string" || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms)) return state;
  const role = event.type === "session.input_transcript.delta" ? "user" : "assistant";
  const captions = state.captions.slice();
  const last = captions.at(-1);
  // Display grouping only; neither gaps nor output text prove turn completion/playback.
  if (last?.role === role && event.start_ms! - last.end < 2500) captions[captions.length - 1] = { ...last, text: last.text + event.delta, end: event.end_ms! };
  else captions.push({ id: captions.length, role, text: event.delta, start: event.start_ms!, end: event.end_ms! });
  return { ...state, captions, captioning: role === "assistant" };
}
export function useAoedeSession(active: boolean, onUi: (frame: Extract<AoedeServerMessage, { type: "aoede:ui" }>) => UiResult) {
  const socket = useSocket();
  const [state, dispatch] = useReducer(reducer, initial);
  const audioRef = useRef<HTMLAudioElement>(null);
  const media = useRef<AoedeMedia | null>(null);
  const generation = useRef(0);
  const muted = useRef(false);
  const readinessController = useRef<AbortController | null>(null);
  const overlayActive = useRef(false);
  const captionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const invocationEpoch = useRef(0);
  const current = useRef({ onUi, state, connected: socket.connected, epoch: socket.connectionEpoch });
  const seen = useRef(new Set<string>());
  // Bounded per invocation. Retries reuse the exact decision/request after an uncertain HTTP result.
  const decisions = useRef(new Map<string, { clientRequestId: string; decision: "approve_once" | "deny" }>());
  const captionSize = useRef(0);
  const chatClient = useRef<ReturnType<typeof createCanonicalShellChatClient> | null>(null);
  const refreshReadiness = useCallback(async (): Promise<void> => {
    if (!overlayActive.current) return;
    readinessController.current?.abort();
    const controller = new AbortController();
    readinessController.current = controller;
    const isCurrent = () => overlayActive.current && !controller.signal.aborted && readinessController.current === controller;
    dispatch({ readiness: { status: "checking", message: "Checking execution access…" } });
    try {
      const response = await fetch(`${getGatewayUrl()}/api/aoede/readiness`, {
        credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) {
        if (isCurrent()) {
          console.warn("[aoede] Execution readiness rejected:", response.status);
          dispatch({ readiness: readinessUnavailable });
        }
        return;
      }
      const readiness = AoedeReadinessSchema.parse(await response.json());
      if (isCurrent()) dispatch({ readiness });
    } catch (error: unknown) {
      if (isCurrent()) {
        console.warn("[aoede] Execution readiness unavailable:", error instanceof Error ? error.name : "UnknownError");
        dispatch({ readiness: readinessUnavailable });
      }
    }
  }, []);
  useEffect(() => {
    overlayActive.current = active;
    if (!active) return;
    void refreshReadiness();
    const refresh = () => { void refreshReadiness(); };
    window.addEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      overlayActive.current = false;
      readinessController.current?.abort();
      window.removeEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [active, refreshReadiness]);
  useEffect(() => { current.current = { onUi, state, connected: socket.connected, epoch: socket.connectionEpoch }; }, [onUi, state, socket.connected, socket.connectionEpoch]);
  const stop = useCallback((status: State["status"]) => {
    generation.current += 1;
    muted.current = false;
    clearTimeout(captionTimer.current);
    const old = media.current; media.current = null; old?.close(); dispatch({ status });
  }, []);
  const send = socket.send;
  const approval = useCallback(async (card: AoedeCard, decision: "approve_once" | "deny", clientRequestId = crypto.randomUUID()) => {
    const invocation = media.current;
    if (!invocation?.sessionId || !card.runId || !card.approval || card.status !== "approval" || !current.current.connected) return;
    const presented = current.current.state.cards.find((entry) => entry.id === card.id);
    if (presented?.status !== "approval" || presented.chatId !== card.chatId || presented.runId !== card.runId
      || presented.approval?.approvalId !== card.approval.approvalId || !presented.approval.allowedDecisions.includes(decision)) return;
    const lock = `decision:${card.chatId}:${card.runId}:${card.approval.approvalId}`;
    if (seen.current.has(lock) || seen.current.size >= 100) return;
    const previous = decisions.current.get(lock);
    if (previous && previous.decision !== decision) { dispatch({ actionError: true }); return; }
    if (!previous && decisions.current.size >= 100) return;
    const httpRequestId = previous?.clientRequestId ?? clientRequestId;
    decisions.current.set(lock, { clientRequestId: httpRequestId, decision });
    seen.current.add(lock); dispatch({ deciding: card.id });
    const sessionId = invocation.sessionId;
    let accepted = false;
    try {
      if (!chatClient.current) chatClient.current = createCanonicalShellChatClient({ gatewayUrl: getGatewayUrl() });
      const result = await chatClient.current.submitApproval(card.chatId, card.runId, card.approval.approvalId,
        decision === "approve_once" ? "approve" : "decline", `req_${httpRequestId}`);
      accepted = result.submission === "accepted";
    } catch (error) {
      console.warn("[aoede] Approval unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (media.current === invocation) dispatch({ actionError: true });
    }
    if (media.current === invocation) {
      if (!accepted) { seen.current.delete(lock); dispatch({ deciding: card.id, finished: true }); }
      dispatch({ actionError: !accepted });
      if (current.current.connected) send({ type: "aoede:approval_result", sessionId,
        approvalId: card.approval.approvalId, clientRequestId, accepted } satisfies AoedeClientMessage);
    }
  }, [send]);
  const start = useCallback(() => {
    if (!overlayActive.current || media.current || !audioRef.current || !current.current.connected) return;
    generation.current += 1;
    muted.current = false;
    invocationEpoch.current = current.current.epoch;
    dispatch({ status: "connecting" }); seen.current.clear(); decisions.current.clear(); captionSize.current = 0;
    let ready = false;
    const invocation = new AoedeMedia({ gatewayUrl: getGatewayUrl(), audio: audioRef.current,
      onFailure: () => { if (media.current === invocation) stop("interrupted"); },
      onEvent: (event) => {
        if (media.current !== invocation) return;
        if (event.type === "session.started" && invocation.sessionId && !ready) {
          ready = true; invocation.started(); dispatch({ status: "active" });
          send({ type: "aoede:ready", sessionId: invocation.sessionId } satisfies AoedeClientMessage);
        } else if (["session.input_transcript.delta", "session.output_transcript.delta"].includes(event.type)) {
          dispatch({ caption: event }); clearTimeout(captionTimer.current);
          // Preserve every received fragment; end explicitly instead of silently dropping earlier text.
          captionSize.current += typeof event.delta === "string" ? Math.max(1, event.delta.length) : 0;
          if (captionSize.current >= 128_000) { stop("caption_limit"); return; }
          captionTimer.current = setTimeout(() => { if (media.current === invocation) dispatch({ captioning: false }); }, 600);
        }
        else if (event.type === "session.closed") stop("closed");
        else if (event.type === "error") stop("error");
      },
    });
    media.current = invocation;
    void invocation.start().catch((error: unknown) => {
      console.warn("[aoede] Startup unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (media.current === invocation) stop(error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "error");
    });
  }, [send, stop]);
  useEffect(() => socket.subscribe((message) => {
    const parsed = AoedeServerMessageSchema.safeParse(message);
    const invocation = media.current;
    if (!parsed.success || !invocation?.sessionId || parsed.data.sessionId !== invocation.sessionId) return;
    const frame = parsed.data;
    if (frame.type === "aoede:state") {
      if (frame.state !== "active") stop(frame.state);
    } else if (frame.type === "aoede:card") dispatch({ card: frame.card });
    else if (frame.type === "aoede:task_error") dispatch({ taskError: frame });
    else if (frame.type === "aoede:ui") {
      const key = `${frame.phase}:${frame.correlationId}`;
      if (seen.current.has(key) || seen.current.size >= 100) return;
      seen.current.add(key);
      let result: UiResult = { status: "failed" };
      try { result = current.current.onUi(frame); }
      catch (error) { console.warn("[aoede] Window action unavailable:", error instanceof Error ? error.name : "UnknownError"); }
      send({ type: "aoede:ui_result", sessionId: frame.sessionId, correlationId: frame.correlationId, phase: frame.phase, ...result } satisfies AoedeClientMessage);
    } else if (frame.type === "aoede:approval_decide") {
      const pending = current.current.state.cards.filter((card) => card.status === "approval" && card.approval);
      const card = pending[0];
      const key = `approval:${frame.clientRequestId}`;
      if (seen.current.has(key) || seen.current.size >= 100) return;
      seen.current.add(key);
      if (pending.length === 1 && card.approval?.risk === "low" && card.chatId === frame.chatId && card.runId === frame.runId
        && card.approval.approvalId === frame.approvalId && card.approval.allowedDecisions.includes(frame.decision)) void approval(card, frame.decision, frame.clientRequestId);
      else send({ type: "aoede:approval_result", sessionId: frame.sessionId, approvalId: frame.approvalId, clientRequestId: frame.clientRequestId, accepted: false } satisfies AoedeClientMessage);
    }
  }), [socket.subscribe, send, approval, stop]);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect, react-doctor/no-set-state-after-await-in-effect -- owner recovery probe is canceled on dismissal/dependency change; both abort state and current invocation are checked before dispatch, so it cannot overwrite a started session.
  useEffect(() => {
    if (!active) { stop("closed"); return; }
    // No billable automatic start/reconnect. The user explicitly starts a fresh session.
    const controller = new AbortController();
    const probeGeneration = generation.current;
    dispatch({ recoveryError: false });
    void fetch(`${getGatewayUrl()}/api/aoede/session`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    }).then(async (response) => {
      if (!response.ok) throw new Error("AoedeSnapshotUnavailable");
      const snapshot: unknown = await response.json();
      if (!controller.signal.aborted && generation.current === probeGeneration && !media.current && typeof snapshot === "object" && snapshot !== null
        && "session" in snapshot && typeof snapshot.session === "object" && snapshot.session !== null
        && "state" in snapshot.session && snapshot.session.state === "interrupted") dispatch({ status: "interrupted" });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && generation.current === probeGeneration && !media.current) {
        console.warn("[aoede] Recovery snapshot unavailable:", error instanceof Error ? error.name : "UnknownError");
        dispatch({ recoveryError: true });
      }
    });
    return () => { controller.abort(); clearTimeout(captionTimer.current); const old = media.current; media.current = null; old?.close(); };
  }, [active, stop]);
  useEffect(() => { if (!socket.connected && media.current) stop("interrupted"); }, [socket.connected, stop]);
  useEffect(() => { if (media.current && invocationEpoch.current !== socket.connectionEpoch) stop("interrupted"); }, [socket.connectionEpoch, stop]);
  const cancel = (card: AoedeCard) => {
    const sessionId = media.current?.sessionId;
    if (sessionId && socket.connected) send({ type: "aoede:cancel", sessionId, cardId: card.id } satisfies AoedeClientMessage);
  };
  const clearRecovery = async () => {
    try {
      const response = await fetch(`${getGatewayUrl()}/api/aoede/recovery`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) { console.warn("[aoede] Recovery deletion not confirmed:", response.status); dispatch({ actionError: true }); }
    } catch (error) {
      console.warn("[aoede] Recovery deletion unavailable:", error instanceof Error ? error.name : "UnknownError"); dispatch({ actionError: true });
    }
  };
  const inputStream = useCallback(() => media.current?.microphoneStream, []);
  const toggleMute = useCallback(() => {
    if (!media.current) return;
    muted.current = !muted.current;
    media.current.setMuted(muted.current);
    dispatch({ muted: muted.current });
  }, []);
  return { ...state, audioRef, inputStream, start, stop, approval, cancel, clearRecovery, refreshReadiness, toggleMute, connected: socket.connected };
}

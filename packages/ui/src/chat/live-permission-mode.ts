import { useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatDetailResponse, CanonicalChatExecutionControls, CanonicalProviderCatalog, CanonicalSetChatPermissionModeRequest, CanonicalSetChatPermissionModeResponse } from "@matrix-os/contracts";

export type ChatPermissionMode = "supervised" | "full_access";
export interface ChatPermissionModeChangeResult { refreshFailed: boolean; }
export const CHAT_PERMISSION_MODE_REFRESH_NOTICE = "Permission mode changed. Reopen this chat to refresh tool requests.";
export const CHAT_PERMISSION_MODE_ERROR = "Could not change permission mode. Try again.";
export interface ChatPermissionModeClient {
  setPermissionMode?(chatId: string, runId: string, input: CanonicalSetChatPermissionModeRequest): Promise<CanonicalSetChatPermissionModeResponse>;
}

/** Catalog support alone cannot grant a live operation to plan/auto/Bot/shared runs. */
export function liveChatPermissionModes(catalog: CanonicalProviderCatalog | null | undefined,
  controls: CanonicalChatExecutionControls | undefined, activeRunId: string | undefined, owner: boolean) {
  if (!owner || !activeRunId || controls?.runId !== activeRunId || controls.interactionMode !== "default"
    || !["supervised", "full_access"].includes(controls.permissionMode)) return undefined;
  return catalog?.instances.find(instance => instance.id === controls.selection.instanceId)?.supports.livePermissionModes;
}

/** Integration and custom-MCP requests retain their exact one-time owner receipts. */
export function builtinToolPermissionModeCallback<T>(approvalId: string, callback: T): T | undefined {
  return approvalId.startsWith("tool_") ? callback : undefined;
}

class PermissionModeAcknowledgedStateUnavailableError extends Error {
  constructor() { super(CHAT_PERMISSION_MODE_ERROR); this.name = "PermissionModeAcknowledgedStateUnavailableError"; }
}
class PermissionModeIntentSupersededError extends PermissionModeAcknowledgedStateUnavailableError {
  constructor() { super(); this.name = "PermissionModeIntentSupersededError"; }
}

/** Missing sequence information never proves that another accepted change came later. */
function permissionIntentWasSuperseded(detail: CanonicalChatDetailResponse | null, runId: string, clientRequestId: string, mode: ChatPermissionMode): boolean {
  if (!detail) return false;
  const events = detail.activities.filter((event): event is Extract<typeof event, { type: "run.permission_mode" }> =>
    event.type === "run.permission_mode" && event.chatId === detail.record.chat.id && event.runId === runId);
  const original = events.find(event => event.clientRequestId === clientRequestId && event.permissionMode === mode);
  if (original?.sequence === undefined || events.some(event => event.sequence === undefined)) return false;
  const latest = events.reduce<typeof original | undefined>((current, event) =>
    !current || event.sequence! > current.sequence! ? event : current, undefined);
  const currentMode = detail.runs.find(run => run.id === runId)?.permissionMode;
  return Boolean(latest && latest.sequence! > original.sequence && latest.clientRequestId !== clientRequestId
    && latest.permissionMode !== mode && latest.permissionMode === currentMode
    && !events.some(event => event.id !== latest.id && event.sequence === latest.sequence));
}

/** A bounded canonical-state watermark also detects changes when older receipts left the history window. */
function permissionStateWatermark(detail: CanonicalChatDetailResponse | null, runId: string): string {
  const run = detail?.runs.find(candidate => candidate.id === runId);
  const events = detail?.activities.filter(event => event.type === "run.permission_mode"
    && event.chatId === detail.record.chat.id && event.runId === runId)
    .map(event => [event.id, event.sequence, event.occurredAt]);
  return JSON.stringify([run?.permissionMode, events]);
}

/** An accepted response changes this exact run only; another Chat/runtime never receives it. */
export async function setCanonicalChatPermissionMode(input: {
  client: ChatPermissionModeClient;
  runId: string;
  permissionMode: ChatPermissionMode;
  clientRequestId?: string;
  getDetail: () => CanonicalChatDetailResponse | null;
  isCurrent: () => boolean;
  commit: (update: (current: CanonicalChatDetailResponse | null) => CanonicalChatDetailResponse | null) => void;
  refresh: (chatId: string) => Promise<unknown>;
}): Promise<ChatPermissionModeChangeResult> {
  const initial = input.getDetail();
  const chatId = initial?.record.chat.id;
  if (!chatId || initial.record.activeRun?.runId !== input.runId || initial.record.chat.ownerScope.type !== "personal"
    || initial.record.chat.collaboration?.mode === "shared" || !input.isCurrent() || !input.client.setPermissionMode) {
    throw new Error(CHAT_PERMISSION_MODE_ERROR);
  }
  const requestWatermark = permissionStateWatermark(initial, input.runId);
  const current = () => input.isCurrent() && input.getDetail()?.record.chat.id === chatId
    && input.getDetail()?.record.activeRun?.runId === input.runId;
  const clientRequestId = input.clientRequestId ?? `req_${crypto.randomUUID().replaceAll("-", "")}`;
  let accepted: CanonicalSetChatPermissionModeResponse;
  try {
    accepted = await input.client.setPermissionMode(chatId, input.runId, {
      clientRequestId,
      permissionMode: input.permissionMode,
    });
  } catch (error: unknown) {
    console.warn("[chat] Permission mode response unavailable:", error instanceof Error ? error.name : "UnknownError");
    // A lost response does not prove rejection. Read canonical state before offering a retry.
    if (current()) {
      let refreshed = false;
      try { refreshed = await input.refresh(chatId) !== null; }
      catch (failure: unknown) { console.warn("[chat] Permission recovery unavailable:", failure instanceof Error ? failure.name : "UnknownError"); }
      if (current() && input.getDetail()?.runs.some(run => run.id === input.runId && run.permissionMode === input.permissionMode)) return { refreshFailed: false };
      if (refreshed && current() && permissionIntentWasSuperseded(input.getDetail(), input.runId, clientRequestId, input.permissionMode)) {
        throw new PermissionModeIntentSupersededError();
      }
    }
    throw new Error(CHAT_PERMISSION_MODE_ERROR);
  }
  if (accepted.chatId !== chatId || accepted.runId !== input.runId || accepted.permissionMode !== input.permissionMode) {
    throw new Error(CHAT_PERMISSION_MODE_ERROR);
  }
  if (!current()) throw new PermissionModeAcknowledgedStateUnavailableError();
  const contradictsAcknowledgement = (detail: CanonicalChatDetailResponse | null) =>
    detail?.runs.find(run => run.id === input.runId)?.permissionMode !== accepted.permissionMode
    && permissionStateWatermark(detail, input.runId) !== requestWatermark;
  if (permissionIntentWasSuperseded(input.getDetail(), input.runId, clientRequestId, accepted.permissionMode)) {
    throw new PermissionModeIntentSupersededError();
  }
  // A response contains no ordering token. Observed concurrency requires a fresh canonical read.
  const needsCanonicalResolution = contradictsAcknowledgement(input.getDetail());
  if (!needsCanonicalResolution) input.commit(detail => {
    if (!current() || detail?.record.chat.id !== chatId || detail.record.activeRun?.runId !== input.runId
      || permissionIntentWasSuperseded(detail, input.runId, clientRequestId, accepted.permissionMode)
      || contradictsAcknowledgement(detail)) return detail;
    return { ...detail, runs: detail.runs.map(run => run.id === input.runId
      ? { ...run, permissionMode: accepted.permissionMode } : run) };
  });
  let refreshFailed = false;
  if (current()) {
    try { refreshFailed = await input.refresh(chatId) === null; }
    catch (error: unknown) {
      console.warn("[chat] Approval refresh unavailable:", error instanceof Error ? error.name : "UnknownError");
      refreshFailed = true;
    }
  }
  if (current() && contradictsAcknowledgement(input.getDetail())) {
    if (refreshFailed) throw new PermissionModeAcknowledgedStateUnavailableError();
    throw new PermissionModeIntentSupersededError();
  }
  if (needsCanonicalResolution && refreshFailed) throw new PermissionModeAcknowledgedStateUnavailableError();
  // A confirmed grant survives an unrelated approval refresh failure, with a visible recovery notice.
  return { refreshFailed };
}

/** Keep next-turn drafts separate from owner-authorized changes to an active run. */
export function useLiveChatPermissionMode(input: {
  scope: string;
  activeRunId?: string;
  liveModes?: readonly string[];
  change?: (runId: string, mode: ChatPermissionMode, clientRequestId: string) => Promise<void | ChatPermissionModeChangeResult>;
  changeDraft: (mode: string) => void;
}) {
  const [attempt, setAttempt] = useState<{ scope: string; pending: boolean; error: string | null; notice: string | null } | null>(null);
  const [observedScope, setObservedScope] = useState(input.scope);
  if (observedScope !== input.scope) {
    setObservedScope(input.scope);
    setAttempt(null);
  }
  const owner = useRef({ scope: input.scope });
  const inFlight = useRef<object | null>(null);
  const intent = useRef<{ scope: string; mode: ChatPermissionMode; requestId: string } | null>(null);
  useLayoutEffect(() => { owner.current = { scope: input.scope }; return () => { owner.current = { scope: "" }; }; }, [input.scope]);
  const supported = Boolean(input.change && input.liveModes?.includes("supervised") && input.liveModes.includes("full_access"));
  const pending = attempt?.scope === input.scope && attempt.pending;
  const disabled = pending || Boolean(input.activeRunId && !supported);
  const disabledReason = input.activeRunId && !supported ? "Permission mode can be changed after this run finishes." : undefined;
  const select = async (mode: ChatPermissionMode) => {
    if (!input.activeRunId) { input.changeDraft(mode); return; }
    const scope = input.scope;
    const ownerAtStart = owner.current;
    if (!supported || inFlight.current === ownerAtStart || ownerAtStart.scope !== scope) throw new Error(CHAT_PERMISSION_MODE_ERROR);
    inFlight.current = ownerAtStart;
    setAttempt({ scope, pending: true, error: null, notice: null });
    let attemptedRequestId: string | undefined;
    try {
      if (intent.current?.scope !== scope || intent.current.mode !== mode) {
        intent.current = { scope, mode, requestId: `req_${crypto.randomUUID().replaceAll("-", "")}` };
      }
      attemptedRequestId = intent.current.requestId;
      const result = await input.change!(input.activeRunId, mode, attemptedRequestId);
      if (intent.current?.requestId === attemptedRequestId) intent.current = null;
      if (owner.current === ownerAtStart) setAttempt({ scope, pending: false, error: null, notice: result?.refreshFailed ? CHAT_PERMISSION_MODE_REFRESH_NOTICE : null });
    } catch (error: unknown) {
      if (error instanceof PermissionModeAcknowledgedStateUnavailableError
        && intent.current?.requestId === attemptedRequestId) intent.current = null;
      console.warn("[chat] Permission mode change failed:", error instanceof Error ? error.name : "UnknownError");
      if (owner.current === ownerAtStart) setAttempt({ scope, pending: false, error: CHAT_PERMISSION_MODE_ERROR, notice: null });
      throw new Error(CHAT_PERMISSION_MODE_ERROR);
    } finally { if (inFlight.current === ownerAtStart) inFlight.current = null; }
  };
  const selectFromComposer = (mode: string) => {
    if (!input.activeRunId) { input.changeDraft(mode); return; }
    if (mode !== "supervised" && mode !== "full_access") return;
    // The hook owns the safe error shown next to the control.
    void select(mode).catch((error: unknown) => { console.warn("[chat] Permission mode control failed:", error instanceof Error ? error.name : "UnknownError"); });
  };
  return { select, selectFromComposer, pending, disabled, disabledReason, supported, activeRun: Boolean(input.activeRunId), liveModes: input.liveModes, error: attempt?.scope === input.scope ? attempt.error : null, notice: attempt?.scope === input.scope ? attempt.notice : null };
}

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
  const current = () => input.isCurrent() && input.getDetail()?.record.chat.id === chatId
    && input.getDetail()?.record.activeRun?.runId === input.runId;
  let accepted: CanonicalSetChatPermissionModeResponse;
  try {
    accepted = await input.client.setPermissionMode(chatId, input.runId, {
      clientRequestId: input.clientRequestId ?? `req_${crypto.randomUUID().replaceAll("-", "")}`,
      permissionMode: input.permissionMode,
    });
  } catch (error: unknown) {
    console.warn("[chat] Permission mode response unavailable:", error instanceof Error ? error.name : "UnknownError");
    // A lost response does not prove rejection. Read canonical state before offering a retry.
    if (current()) {
      try { await input.refresh(chatId); }
      catch (failure: unknown) { console.warn("[chat] Permission recovery unavailable:", failure instanceof Error ? failure.name : "UnknownError"); }
      if (current() && input.getDetail()?.runs.some(run => run.id === input.runId && run.permissionMode === input.permissionMode)) return { refreshFailed: false };
    }
    throw new Error(CHAT_PERMISSION_MODE_ERROR);
  }
  if (accepted.chatId !== chatId || accepted.runId !== input.runId || accepted.permissionMode !== input.permissionMode || !current()) {
    throw new Error(CHAT_PERMISSION_MODE_ERROR);
  }
  input.commit(detail => current() && detail ? { ...detail, runs: detail.runs.map(run => run.id === input.runId
    ? { ...run, permissionMode: accepted.permissionMode } : run) } : detail);
  // The permission is already confirmed. A failed approval refresh must not report a failed grant.
  if (current()) {
    try { return { refreshFailed: await input.refresh(chatId) === null }; }
    catch (error: unknown) {
      console.warn("[chat] Approval refresh unavailable:", error instanceof Error ? error.name : "UnknownError");
      return { refreshFailed: true };
    }
  }
  return { refreshFailed: false };
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
    try {
      if (intent.current?.scope !== scope || intent.current.mode !== mode) {
        intent.current = { scope, mode, requestId: `req_${crypto.randomUUID().replaceAll("-", "")}` };
      }
      const result = await input.change!(input.activeRunId, mode, intent.current.requestId);
      if (intent.current?.scope === scope && intent.current.mode === mode) intent.current = null;
      if (owner.current === ownerAtStart) setAttempt({ scope, pending: false, error: null, notice: result?.refreshFailed ? CHAT_PERMISSION_MODE_REFRESH_NOTICE : null });
    } catch (error: unknown) {
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

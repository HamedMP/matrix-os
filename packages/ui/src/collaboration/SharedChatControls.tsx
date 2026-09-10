import {
  CollaborationAiRequestSchema,
  CollaborationAiRequestsResponseSchema,
  type CollaborationApproval,
  type CollaborationAiRequest,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import type { CollaborationDraft } from "./chat-state.js";

type AiAvailability = "checking" | "available" | "unavailable";
type SharedAiError = "request" | "control" | "recovery" | null;
type SharedAiState = {
  availability: AiAvailability;
  requests: CollaborationAiRequest[];
  approvals: CollaborationApproval[];
  defaultSelection: CollaborationAiRequest["selection"] | null;
  pendingAction: string | null;
  error: SharedAiError;
};
type SharedAiAction =
  | { type: "loaded"; response: ReturnType<typeof CollaborationAiRequestsResponseSchema.parse> }
  | { type: "unavailable"; retainQueue: boolean }
  | { type: "action_started"; key: string }
  | { type: "action_finished" }
  | { type: "action_failed"; error: Exclude<SharedAiError, null> }
  | { type: "request_accepted"; request: CollaborationAiRequest };

const initialSharedAiState: SharedAiState = {
  availability: "checking",
  requests: [],
  approvals: [],
  defaultSelection: null,
  pendingAction: null,
  error: null,
};

export function SharedChatControls({
  api,
  scope,
  actorId,
  resourceRevision,
  draft,
  updateDraft,
  changeDraftMode,
  discussionSending,
  discussionError,
  sendDiscussion,
  refreshVersion,
}: {
  api: CollaborationApi;
  scope: CollaborationScope;
  actorId: string;
  resourceRevision: string;
  draft: CollaborationDraft;
  updateDraft(text: string, mode: CollaborationDraft["mode"]): void;
  changeDraftMode(mode: CollaborationDraft["mode"]): void;
  discussionSending: boolean;
  discussionError: boolean;
  sendDiscussion(): Promise<void>;
  refreshVersion: number;
}) {
  const controller = useSharedAiController({ api, scope, actorId, resourceRevision, draft, updateDraft, refreshVersion });
  const { state, submitAi, control, decide } = controller;
  const presentation = sharedComposerPresentation(scope, state, draft, discussionSending);
  const submit = presentation.aiMode ? submitAi : sendDiscussion;
  return <footer className="border-t p-4 sm:px-6">
    <SharedComposerHeader presentation={presentation} changeDraftMode={changeDraftMode} />
    <OptionalSharedAiQueue visible={presentation.showQueue} requests={state.requests} approvals={state.approvals}
      actorId={actorId} role={scope.role} pendingAction={state.pendingAction} control={control} decide={decide} />
    <SharedAiErrors discussionError={discussionError && !presentation.aiMode} error={state.error} />
    <SharedComposerInput presentation={presentation} draft={draft} updateDraft={updateDraft} submit={submit} />
  </footer>;
}

type SharedComposerPresentation = {
  aiMode: boolean;
  canDiscuss: boolean;
  canRequestAi: boolean;
  canCompose: boolean;
  sending: boolean;
  showQueue: boolean;
  status: string;
  inputLabel: string;
  placeholder: string;
  submitLabel: string;
};

function sharedComposerPresentation(
  scope: CollaborationScope,
  state: SharedAiState,
  draft: CollaborationDraft,
  discussionSending: boolean,
): SharedComposerPresentation {
  const writableRole = scope.role === "owner" || scope.role === "editor";
  const canDiscuss = scope.lifecycle === "shared" && writableRole && scope.capabilities.discuss;
  const canRequestAi = scope.lifecycle === "shared" && writableRole
    && state.availability === "available" && state.defaultSelection !== null;
  const aiMode = draft.mode === "ai";
  const canCompose = aiMode ? canRequestAi : canDiscuss;
  const sending = discussionSending || state.pendingAction === "submit";
  const status = !writableRole ? "Viewers can read this Chat but cannot post messages or request AI."
    : state.availability === "checking" ? "Checking shared AI…"
      : state.availability === "available" ? "One active run · up to 32 pending"
        : "AI requests are unavailable; discussion still works.";
  return {
    aiMode, canDiscuss, canRequestAi, canCompose, sending, status,
    showQueue: aiMode && state.availability === "available",
    inputLabel: aiMode ? "Ask AI" : "Message everyone",
    placeholder: !canCompose ? "Read-only access" : aiMode ? "Ask AI for everyone…" : "Message everyone…",
    submitLabel: sending ? "Sending…" : aiMode ? "Request AI" : "Send message",
  };
}

function SharedComposerHeader({ presentation, changeDraftMode }: {
  presentation: SharedComposerPresentation;
  changeDraftMode(mode: CollaborationDraft["mode"]): void;
}) {
  return <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
    <div className="flex rounded-xl border p-1" aria-label="Composer mode">
      <button type="button" aria-pressed={!presentation.aiMode} className={modeButtonClass(!presentation.aiMode)}
        disabled={!presentation.canDiscuss || presentation.sending} onClick={() => changeDraftMode("discussion")}>Discussion</button>
      <button type="button" aria-pressed={presentation.aiMode} className={modeButtonClass(presentation.aiMode)}
        disabled={!presentation.canRequestAi || presentation.sending} onClick={() => changeDraftMode("ai")}>Ask AI</button>
    </div>
    <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{presentation.status}</span>
  </div>;
}

function OptionalSharedAiQueue({ visible, ...props }: Parameters<typeof SharedAiQueue>[0] & { visible: boolean }) {
  return visible ? <SharedAiQueue {...props} /> : null;
}

function SharedComposerInput({ presentation, draft, updateDraft, submit }: {
  presentation: SharedComposerPresentation;
  draft: CollaborationDraft;
  updateDraft(text: string, mode: CollaborationDraft["mode"]): void;
  submit(): Promise<void>;
}) {
  return <div className="flex items-end gap-2">
    <label className="min-w-0 flex-1"><span className="sr-only">{presentation.inputLabel}</span>
      <textarea aria-label={presentation.inputLabel} rows={3} value={draft.text}
        disabled={!presentation.canCompose || presentation.sending} placeholder={presentation.placeholder}
        onChange={(event) => updateDraft(event.target.value, draft.mode)}
        className="block w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60" />
    </label>
    <button type="button" className={buttonClass}
      disabled={!presentation.canCompose || presentation.sending || !draft.text.trim()}
      onClick={() => void submit()}>{presentation.submitLabel}</button>
  </div>;
}

function useSharedAiController({ api, scope, actorId, resourceRevision, draft, updateDraft, refreshVersion }: {
  api: CollaborationApi;
  scope: CollaborationScope;
  actorId: string;
  resourceRevision: string;
  draft: CollaborationDraft;
  updateDraft(text: string, mode: CollaborationDraft["mode"]): void;
  refreshVersion: number;
}) {
  const [state, dispatch] = useReducer(reduceSharedAi, initialSharedAiState);
  const hadAvailable = useRef(false);
  const endpoint = `/api/collaboration/scopes/${encodeURIComponent(scope.id)}/chat`;

  const load = useCallback(async () => {
    try {
      const response = CollaborationAiRequestsResponseSchema.parse(await api.get(`${endpoint}/requests`));
      hadAvailable.current = true;
      dispatch({ type: "loaded", response });
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] shared AI recovery failed",
        failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "unavailable", retainQueue: hadAvailable.current });
    }
  }, [api, endpoint]);

  useEffect(() => { void load(); }, [load, refreshVersion]);

  const writableRole = scope.role === "owner" || scope.role === "editor";
  const canRequestAi = scope.lifecycle === "shared" && writableRole
    && state.availability === "available" && state.defaultSelection !== null;

  const submitAi = async () => {
    if (!canRequestAi || !state.defaultSelection || !draft.text.trim() || state.pendingAction) return;
    dispatch({ type: "action_started", key: "submit" });
    try {
      const accepted = CollaborationAiRequestSchema.parse(await api.post(`${endpoint}/requests`, {
        clientRequestId: crypto.randomUUID(),
        expectedRevision: scope.revision,
        text: draft.text.trim(),
        selection: state.defaultSelection,
      }));
      dispatch({ type: "request_accepted", request: accepted });
      updateDraft("", "ai");
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] shared AI request failed",
        failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "action_failed", error: "request" });
    } finally {
      dispatch({ type: "action_finished" });
    }
  };

  const control = async (request: CollaborationAiRequest, action: "cancel" | "retry") => {
    const key = `${action}:${request.id}`;
    if (!canControl(scope.role, actorId, request) || state.pendingAction) return;
    dispatch({ type: "action_started", key });
    try {
      await api.post(`${endpoint}/requests/${encodeURIComponent(request.id)}/${action}`, {
        clientRequestId: crypto.randomUUID(),
        expectedRevision: resourceRevision,
      });
      await load();
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] shared AI control failed",
        failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "action_failed", error: "control" });
    } finally {
      dispatch({ type: "action_finished" });
    }
  };

  const decide = async (approval: CollaborationApproval, decision: "approve" | "approve_for_session" | "decline" | "cancel") => {
    const key = `approval:${approval.approvalId}`;
    if (scope.role !== "owner" || state.pendingAction) return;
    dispatch({ type: "action_started", key });
    try {
      await api.post(`${endpoint}/approvals/${encodeURIComponent(approval.approvalId)}/decision`, {
        clientRequestId: crypto.randomUUID(),
        expectedRevision: resourceRevision,
        runId: approval.runId,
        decision,
      });
      await load();
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] shared AI approval failed",
        failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "action_failed", error: "control" });
    } finally {
      dispatch({ type: "action_finished" });
    }
  };
  return { state, submitAi, control, decide };
}

function reduceSharedAi(state: SharedAiState, action: SharedAiAction): SharedAiState {
  switch (action.type) {
    case "loaded":
      return {
        ...state,
        availability: "available",
        requests: action.response.requests,
        approvals: action.response.approvals,
        defaultSelection: action.response.defaultSelection,
        error: null,
      };
    case "unavailable":
      return {
        ...state,
        availability: action.retainQueue ? "available" : "unavailable",
        error: action.retainQueue ? "recovery" : null,
      };
    case "action_started": return { ...state, pendingAction: action.key, error: null };
    case "action_finished": return { ...state, pendingAction: null };
    case "action_failed": return { ...state, error: action.error };
    case "request_accepted":
      return state.requests.some((request) => request.id === action.request.id)
        ? state
        : { ...state, requests: [...state.requests, action.request].sort(compareAcceptedSequence) };
  }
}

function SharedAiErrors({ discussionError, error }: { discussionError: boolean; error: SharedAiError }) {
  return <>
    {discussionError ? <p role="alert" className="mb-2 text-sm">Message was not sent. Your draft is still here—try again.</p> : null}
    {error === "request" ? <p role="alert" className="mb-2 text-sm">AI request was not accepted. Your draft is still here—try again.</p> : null}
    {error === "control" ? <p role="alert" className="mb-2 text-sm">The request changed or the control could not be applied. Refresh and try again.</p> : null}
    {error === "recovery" ? <p role="alert" className="mb-2 text-sm">Queue updates are delayed. The last confirmed order is shown.</p> : null}
  </>;
}

function SharedAiQueue({ requests, approvals, actorId, role, pendingAction, control, decide }: {
  requests: CollaborationAiRequest[];
  approvals: CollaborationApproval[];
  actorId: string;
  role: CollaborationScope["role"];
  pendingAction: string | null;
  control(request: CollaborationAiRequest, action: "cancel" | "retry"): Promise<void>;
  decide(approval: CollaborationApproval, decision: "approve" | "approve_for_session" | "decline" | "cancel"): Promise<void>;
}) {
  const pendingApprovals = role === "owner" ? approvals.reduce<CollaborationApproval[]>((pending, approval) => {
    if (approval.state === "pending") pending.push(approval);
    return pending;
  }, []) : [];
  return <section aria-label="Shared AI queue" className="mb-3 max-h-56 space-y-2 overflow-y-auto rounded-xl border p-3">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-medium">AI requests</h2>
      <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{requests.length} accepted</span>
    </div>
    {requests.length === 0 ? <p className="text-sm" style={{ color: "var(--text-secondary)" }}>No AI requests yet.</p>
      : requests.map((request) => {
        const controllable = canControl(role, actorId, request);
        const cancel = ["queued", "claimed", "running", "waiting_for_approval"].includes(request.state);
        const retry = ["cancelled", "interrupted", "unauthorized", "unavailable"].includes(request.state);
        return <article key={request.id} className="rounded-lg border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{request.acceptedSequence} · {request.actor.displayName}</span>
            <span className="rounded-full border px-2 py-0.5">{requestStateLabel(request.state)}</span>
            <span className="min-w-0 flex-1 truncate" title={request.text}>{request.text}</span>
            {controllable && cancel ? <button type="button" className={smallButtonClass}
              aria-label={`Cancel request ${request.acceptedSequence}`}
              disabled={pendingAction !== null} onClick={() => void control(request, "cancel")}>Cancel</button> : null}
            {controllable && retry ? <button type="button" className={smallButtonClass}
              aria-label={`Retry request ${request.acceptedSequence}`}
              disabled={pendingAction !== null} onClick={() => void control(request, "retry")}>Retry</button> : null}
          </div>
        </article>;
      })}
    {pendingApprovals.map((approval) =>
      <article key={`${approval.runId}:${approval.approvalId}`} className="rounded-lg border p-3">
        <p className="text-sm font-medium">Approval needed: {approval.title}</p>
        <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>Risk: {approval.risk}</p>
        <div className="mt-2 flex flex-wrap gap-2">{approval.allowedDecisions.map((decision) =>
          <button key={decision} type="button" className={smallButtonClass}
            aria-label={`${decisionLabel(decision)} ${approval.title}`} disabled={pendingAction !== null}
            onClick={() => void decide(approval, decision)}>{decisionLabel(decision)}</button>)}</div>
      </article>)}
  </section>;
}

function canControl(role: CollaborationScope["role"], actorId: string, request: CollaborationAiRequest): boolean {
  return role === "owner" || (role === "editor" && request.actor.actorId === actorId);
}

function compareAcceptedSequence(left: CollaborationAiRequest, right: CollaborationAiRequest): number {
  return BigInt(left.acceptedSequence) < BigInt(right.acceptedSequence) ? -1
    : BigInt(left.acceptedSequence) > BigInt(right.acceptedSequence) ? 1 : 0;
}

function requestStateLabel(state: CollaborationAiRequest["state"]): string {
  return state.replaceAll("_", " ");
}

function decisionLabel(decision: "approve" | "approve_for_session" | "decline" | "cancel"): string {
  return decision === "approve_for_session" ? "Approve for session"
    : decision[0]!.toUpperCase() + decision.slice(1);
}

function modeButtonClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${active ? "bg-[var(--bg-hover)] font-medium" : ""}`;
}

const buttonClass = "rounded-xl border px-4 py-2 text-sm font-medium transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";
const smallButtonClass = "rounded-lg border px-2 py-1 text-xs transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

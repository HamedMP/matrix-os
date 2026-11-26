import { randomUUID } from "../random-uuid.js";
import {
  COLLABORATION_PAGE_LIMIT,
  CollaborationAiRequestAcceptedResponseSchema,
  CollaborationAiRequestsResponseSchema,
  type CollaborationApproval,
  type CollaborationAiRequest,
  type CollaborationScope,
  type CanonicalChatModelSelection,
} from "@matrix-os/contracts";
import { Users } from "lucide-react";
import { Button } from "../Button.js";
import { ChatPromptInput } from "../chat/composer/ChatPromptInput.js";
import { CHAT_CONTENT_WIDTH_CLASS } from "../chat/ChatConversation.js";
import { useCallback, useEffect, useReducer, useRef, type ReactNode } from "react";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import type { CollaborationDraft } from "./chat-state.js";

type AiAvailability = "checking" | "available" | "unavailable" | "owner_reconnect_required";
type SharedAiError = "request" | "control" | "recovery" | null;
type SharedAiState = {
  availability: AiAvailability;
  requests: CollaborationAiRequest[];
  approvals: CollaborationApproval[];
  pendingAction: string | null;
  error: SharedAiError;
  selection?: CanonicalChatModelSelection;
};
type SharedAiAction =
  | { type: "loaded"; response: ReturnType<typeof CollaborationAiRequestsResponseSchema.parse> }
  | { type: "unavailable" }
  | { type: "refresh_failed"; retainQueue: boolean }
  | { type: "action_started"; key: string }
  | { type: "action_finished" }
  | { type: "action_failed"; error: Exclude<SharedAiError, null> }
  | { type: "request_accepted"; request: CollaborationAiRequest };

const initialSharedAiState: SharedAiState = {
  availability: "checking",
  requests: [],
  approvals: [],
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
  refreshVersion,
  renderHistory,
  renderedMessageIds,
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
  renderHistory?: (renderStatus: (messageId: string) => ReactNode) => ReactNode;
  renderedMessageIds?: readonly string[];
}) {
  const controller = useSharedAiController({ api, scope, actorId, resourceRevision, draft, updateDraft, refreshVersion });
  const { state, submitAi, control, decide } = controller;
  const presentation = sharedComposerPresentation(scope, state);
  // Response pages contain at most 100 requests; these render-local indexes are
  // rebuilt on refresh and retain only the latest page after optimistic submits.
  const inlineRequests = state.requests.slice(-COLLABORATION_PAGE_LIMIT).filter(request => request.messageId);
  const requestsByMessage = new Map(inlineRequests.map(request => [request.messageId, request]));
  // Only candidate request keys can enter this render-local Set (at most one
  // response page), even when the paginated transcript is much larger.
  const renderedRequests = new Set<string>();
  for (const messageId of renderedMessageIds ?? []) {
    if (requestsByMessage.has(messageId)) renderedRequests.add(messageId);
  }
  const inlineApprovals = new Set(inlineRequests.filter(request => request.messageId !== undefined
    && renderedRequests.has(request.messageId)).map(request => request.id));
  const relevantRequests = state.requests.filter((request) => request.state !== "completed"
    && (!renderHistory || !request.messageId || !renderedRequests.has(request.messageId)));
  return <>
    {renderHistory?.((messageId) => {
      const request = requestsByMessage.get(messageId);
      return request && request.state !== "completed" ? <SharedAiQueue inline requests={[request]}
        approvals={state.approvals.filter(approval => approval.requestId === request.id)}
        actorId={actorId} role={scope.role} pendingAction={state.pendingAction} control={control} decide={decide} /> : null;
    })}
    <footer className="px-4 pb-5 pt-2 sm:px-6 sm:pb-6 lg:px-8">
    <div className={`mx-auto ${CHAT_CONTENT_WIDTH_CLASS}`}>
      <OptionalSharedAiQueue visible={presentation.showQueue} requests={relevantRequests} approvals={state.approvals.filter(approval => !renderHistory || !inlineApprovals.has(approval.requestId))}
        actorId={actorId} role={scope.role} pendingAction={state.pendingAction} control={control} decide={decide} />
      <SharedAiErrors discussionError={false} error={state.error} />
      {!presentation.canCompose ? <p role="status" className="mb-2 text-xs text-muted-foreground">
        {presentation.status}
      </p> : null}
      <SharedComposerInput presentation={presentation} draft={{ ...draft, mode: "ai" }}
        updateDraft={(text) => updateDraft(text, "ai")} submit={submitAi} />
      <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <Users aria-hidden className="size-3" />
        {scope.membershipMode === "inherited"
          ? "Project members see this Chat · AI uses the project’s files"
          : "People with access see this Chat · AI uses this Chat’s shared context"}
      </p>
    </div>
  </footer></>;
}

type SharedComposerPresentation = {
  canRequestAi: boolean;
  canCompose: boolean;
  sending: boolean;
  showQueue: boolean;
  status: string;
  inputLabel: string;
  placeholder: string;
  submitLabel: string;
  modelLabel?: string;
};

function sharedComposerPresentation(
  scope: CollaborationScope,
  state: SharedAiState,
): SharedComposerPresentation {
  const writableRole = scope.role === "owner" || scope.role === "editor";
  const canRequestAi = scope.lifecycle === "shared" && writableRole
    && scope.capabilities.requestAi && (state.availability === "available"
      || scope.membershipMode === "inherited" && state.availability === "checking");
  const sending = state.pendingAction === "submit";
  const status = !writableRole ? "Viewers can read this Chat but cannot post messages or request AI."
    : state.availability === "checking" ? "Checking shared AI…"
      : state.availability === "available" ? "One active run · up to 32 pending"
        : state.availability === "owner_reconnect_required"
          ? "Reconnect your Claude account or API key in Settings → Agents & providers to resume AI requests."
          : "AI requests are unavailable.";
  const relevantRequests = state.requests.filter((request) => request.state !== "completed");
  const retryable = relevantRequests.some((request) => ["cancelled", "interrupted", "unauthorized", "unavailable"].includes(request.state));
  return {
    canRequestAi, canCompose: canRequestAi, sending, status,
    showQueue: state.availability === "available"
      && (relevantRequests.length > 0
        || retryable
        || state.approvals.some((approval) => approval.state === "pending")),
    inputLabel: "Message Chat",
    placeholder: !writableRole ? "Read-only access" : canRequestAi ? "Message Chat…" : "AI is unavailable",
    submitLabel: sending ? "Sending…" : "Send",
    ...(state.selection ? { modelLabel: `${state.selection.instanceId === "codex_default" ? "Codex"
      : ["claude_shared", "claude_code_default"].includes(state.selection.instanceId) ? "Claude" : "AI"} · ${state.selection.model}` } : {}),
  };
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
  return <div data-slot="shared-chat-composer">
    <ChatPromptInput value={draft.text} onChange={text => updateDraft(text, draft.mode)}
      onSubmit={() => void submit()} busy={presentation.sending}
      disabled={!presentation.canCompose || presentation.sending}
      ariaLabel={presentation.inputLabel} placeholder={presentation.placeholder}
      controls={presentation.modelLabel ? <span aria-label="Configured agent" className="px-2 py-1 text-xs text-muted-foreground">{presentation.modelLabel}</span> : null}
      sendLabel={presentation.submitLabel} />
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
  const latestResourceRevision = useRef(resourceRevision);
  const endpoint = `/api/collaboration/scopes/${encodeURIComponent(scope.id)}/chat`;

  useEffect(() => { latestResourceRevision.current = resourceRevision; }, [resourceRevision]);

  const load = useCallback(async () => {
    try {
      const response = CollaborationAiRequestsResponseSchema.parse(await api.get(`${endpoint}/requests?includeMessageIds=1`));
      latestResourceRevision.current = response.resourceRevision;
      hadAvailable.current = response.capability.status === "available";
      dispatch({ type: "loaded", response });
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] shared AI recovery failed",
        failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "refresh_failed", retainQueue: hadAvailable.current
        || scope.membershipMode === "inherited" });
    }
  }, [api, endpoint, scope.membershipMode]);

  useEffect(() => {
    if (!scope.capabilities.requestAi) {
      dispatch({ type: "unavailable" });
      return;
    }
    void load();
  }, [load, refreshVersion, scope.capabilities.requestAi]);

  const writableRole = scope.role === "owner" || scope.role === "editor";
  const canRequestAi = scope.lifecycle === "shared" && writableRole
    && scope.capabilities.requestAi && (state.availability === "available"
      || scope.membershipMode === "inherited" && state.availability === "checking");

  const submitAi = async () => {
    if (!canRequestAi || !draft.text.trim() || state.pendingAction) return;
    dispatch({ type: "action_started", key: "submit" });
    try {
      const accepted = CollaborationAiRequestAcceptedResponseSchema.parse(await api.post(`${endpoint}/requests`, {
        clientRequestId: randomUUID(),
        expectedRevision: latestResourceRevision.current,
        text: draft.text.trim(),
      }));
      latestResourceRevision.current = accepted.resourceRevision;
      dispatch({ type: "request_accepted", request: accepted.request });
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
        clientRequestId: randomUUID(),
        expectedRevision: latestResourceRevision.current,
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
        clientRequestId: randomUUID(),
        expectedRevision: latestResourceRevision.current,
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
        availability: sharedAiAvailability(action.response.capability.status),
        requests: action.response.requests,
        approvals: action.response.approvals,
        selection: action.response.capability.effectiveSelection,
        error: null,
      };
    case "unavailable":
      return { ...state, availability: "unavailable", error: null };
    case "refresh_failed":
      // A failed refresh keeps the last confirmed state: an available queue is
      // retained with a recovery notice, and an owner reconnect requirement is
      // never promoted to available or degraded to the generic copy.
      return {
        ...state,
        availability: action.retainQueue ? "available"
          : state.availability === "owner_reconnect_required" ? "owner_reconnect_required" : "unavailable",
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

function sharedAiAvailability(
  status: "available" | "unavailable" | "owner_binding_required" | "owner_reconnect_required",
): AiAvailability {
  if (status === "available" || status === "owner_reconnect_required") return status;
  return "unavailable";
}

function SharedAiErrors({ discussionError, error }: { discussionError: boolean; error: SharedAiError }) {
  return <>
    {discussionError ? <p role="alert" className="mb-2 text-sm">Message was not sent. Your draft is still here—try again.</p> : null}
    {error === "request" ? <p role="alert" className="mb-2 text-sm">AI request was not accepted. Your draft is still here—try again.</p> : null}
    {error === "control" ? <p role="alert" className="mb-2 text-sm">The request changed or the control could not be applied. Refresh and try again.</p> : null}
    {error === "recovery" ? <p role="status" className="mb-2 text-xs text-muted-foreground">Connection delayed. You can still try sending your message.</p> : null}
  </>;
}

function SharedAiQueue({ requests, approvals, actorId, role, pendingAction, control, decide, inline = false }: {
  inline?: boolean;
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
  return <section aria-label={inline ? "Reply status" : "Chat activity"}
    className={inline ? "ml-auto mt-2 min-w-0 max-w-[min(85%,48rem)] space-y-2" : "mb-3 min-w-0 max-h-40 space-y-2 overflow-y-auto overflow-x-hidden"}>
    {requests.length === 0 ? null
      : requests.map((request) => {
        const controllable = canControl(role, actorId, request);
        const cancel = ["queued", "claimed", "running", "waiting_for_approval"].includes(request.state);
        const retry = ["cancelled", "interrupted", "unauthorized", "unavailable"].includes(request.state);
        return <article key={request.id} className="flex min-w-0 w-full items-center rounded-lg px-1 py-1.5">
          <div className={`flex min-w-0 w-full flex-wrap items-center gap-2 text-xs ${inline ? "justify-end" : ""}`}>
            {inline ? null : <span className="font-medium">{request.actor.displayName}</span>}
            <span className="text-muted-foreground">{requestStateLabel(request.state)}</span>
            {inline ? null : <span className="min-w-0 flex-1 truncate" title={request.text}>{request.text}</span>}
            {controllable && cancel ? <Button variant="secondary" size="sm"
              aria-label={`Cancel request ${request.acceptedSequence}`}
              disabled={pendingAction !== null} onClick={() => void control(request, "cancel")}>Cancel</Button> : null}
            {controllable && retry ? <Button variant="secondary" size="sm"
              aria-label={`Retry request ${request.acceptedSequence}`}
              disabled={pendingAction !== null} onClick={() => void control(request, "retry")}>Retry</Button> : null}
          </div>
        </article>;
      })}
    {pendingApprovals.map((approval) =>
      <article key={`${approval.runId}:${approval.approvalId}`} className="rounded-lg border p-3">
        <p className="text-sm font-medium">Approval needed: {approval.title}</p>
        <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>Risk: {approval.risk}</p>
        <div className="mt-2 flex flex-wrap gap-2">{approval.allowedDecisions.map((decision) =>
          <Button key={decision} variant="secondary" size="sm"
            aria-label={`${decisionLabel(decision)} ${approval.title}`} disabled={pendingAction !== null}
            onClick={() => void decide(approval, decision)}>{decisionLabel(decision)}</Button>)}</div>
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
  return state === "queued" ? "Preparing reply…" : state === "claimed" || state === "running"
    ? "Working…" : state === "waiting_for_approval" ? "Tool approval needed"
      : state === "interrupted" ? "Reply interrupted"
        : state === "unavailable" ? "AI unavailable for this request"
          : state === "failed" ? "Reply failed"
            : state === "cancelled" ? "Request cancelled"
              : state === "unauthorized" ? "Access changed" : state.replaceAll("_", " ");
}

function decisionLabel(decision: "approve" | "approve_for_session" | "decline" | "cancel"): string {
  return decision === "approve_for_session" ? "Approve for session"
    : decision[0]!.toUpperCase() + decision.slice(1);
}

const buttonClass = "rounded-xl border px-4 py-2 text-sm font-medium transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

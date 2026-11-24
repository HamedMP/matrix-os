import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import {
  ProjectSetupResponseSchema,
  type ProjectSetupAction,
  type ProjectSetupDraft,
  type CanonicalChatModelSelection,
} from "@matrix-os/contracts";

export interface ProjectSetupTransport {
  get(path: string, signal: AbortSignal): Promise<unknown>;
  post(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  patch(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
}
export const PROJECT_SETUP_ERROR = "Project setup could not be updated. Your answers are kept. Try again.";

interface Options {
  client: ProjectSetupTransport | null;
  scope: string;
  projectId?: string | null;
  chatId?: string | null;
  eligible: boolean;
  selection?: CanonicalChatModelSelection | null;
  onOpenChat?: (chatId: string) => void;
  onChanged?: () => void;
}

function canonicalSetupSelection(selection: CanonicalChatModelSelection): CanonicalChatModelSelection {
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options ? { options: selection.options.map(({ id, value }) => ({ id, value })) } : {}),
  };
}

function waitingForSetupReply(draft: ProjectSetupDraft | null) {
  return draft?.generation?.status === "running"
    || Boolean(draft?.interview && draft.generation?.status === "pending");
}

function setupReplyFailed(draft: ProjectSetupDraft | null) {
  return Boolean(draft?.interview
    && (draft.generation?.status === "failed" || draft.generation?.status === "unavailable"));
}

/** Chat owns accepted setup state. This hook holds only the currently scoped view. */
export function useProjectSetup(options: Options) {
  const { client, scope, projectId, chatId, eligible, selection } = options;
  const identity = JSON.stringify([scope, projectId, chatId ?? "new"]);
  const [state, setState] = useState<{
    identity: string;
    draft: ProjectSetupDraft | null;
    introduction: boolean;
    pending: boolean;
    error: string | null;
  }>({ identity, draft: null, introduction: false, pending: false, error: null });
  const [reviewMcpKey, setReviewMcpKey] = useState<string | null>(null);
  const lifetime = useRef<{ identity: string; controller: AbortController } | null>(null);
  const request = useRef<AbortController | null>(null);
  const attempt = useRef<{ identity: string; key: string; requestId: string } | null>(null);
  const currentState =
    state.identity === identity
      ? state
      : { identity, draft: null, introduction: false, pending: false, error: null };
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  const openChat = useEffectEvent((id: string) => options.onOpenChat?.(id));
  const changed = useEffectEvent(() => options.onChanged?.());

  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = { identity, controller };
    attempt.current = null;
    setState({ identity, draft: null, introduction: false, pending: false, error: null });
    return () => {
      controller.abort();
      request.current?.abort();
      request.current = null;
      lifetime.current = null;
    };
  }, [identity, client, eligible]);

  const run = useCallback(
    async (operation: (signal: AbortSignal) => Promise<unknown>, navigate = false): Promise<boolean> => {
      const session = lifetime.current;
      if (!client || !eligible || !projectId || !session || session.identity !== identity || request.current)
        return false;
      const controller = new AbortController();
      request.current = controller;
      const signal = AbortSignal.any([session.controller.signal, controller.signal]);
      const current = () => !signal.aborted && lifetime.current === session;
      setState((previous) => ({ ...previous, identity, introduction: navigate && !chatId, pending: true, error: null }));
      try {
        const result = ProjectSetupResponseSchema.parse(await operation(signal));
        if (!current()) return false;
        if (result.draft && (result.draft.projectId !== projectId || (chatId && result.draft.chatId !== chatId)))
          throw new Error("Setup scope mismatch");
        if (navigate && !result.draft) throw new Error("Setup draft unavailable");
        const next = {
          identity,
          draft: result.draft,
          introduction: false,
          pending: false,
          error: null,
        };
        stateRef.current = next;
        setState(next);
        if (navigate && result.draft && result.draft.chatId !== chatId) openChat(result.draft.chatId);
        changed();
        return true;
      } catch (error: unknown) {
        if (current()) {
          console.warn(
            "[project-setup] Request unavailable",
            error instanceof Error ? error.name : "UnknownError",
          );
          setState((previous) => ({ ...previous, identity, pending: false, error: PROJECT_SETUP_ERROR }));
        }
        return false;
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [chatId, client, eligible, identity, projectId],
  );

  const reload = useCallback(() => {
    if (!client || !chatId) return Promise.resolve(false);
    return run((signal) => client.get(`/api/chats/${encodeURIComponent(chatId)}/project-setup`, signal));
  }, [chatId, client, run]);
  useEffect(() => {
    if (chatId && eligible) void reload();
  }, [chatId, eligible, reload]);

  const requestId = (key: string) => {
    if (attempt.current?.identity !== identity || attempt.current.key !== key) {
      attempt.current = { identity, key, requestId: `req_setup_${crypto.randomUUID()}` };
    }
    return attempt.current.requestId;
  };
  const strictSelection = selection ? canonicalSetupSelection(selection) : undefined;
  const start = async () => {
    if (!client || !projectId) return false;
    const payload = {
      mode: "interview",
      ...(strictSelection ? { currentSelection: strictSelection } : {}),
    };
    const body = { ...payload, clientRequestId: requestId(JSON.stringify(["start", payload])) };
    return run((signal) => client.post(`/api/projects/${encodeURIComponent(projectId)}/setup`, body, signal), true);
  };
  const dispatch = async (action: ProjectSetupAction): Promise<boolean> => {
    const draft = stateRef.current.draft;
    if (!client || !draft || draft.projectId !== projectId) return false;
    const followUp = action.type === "stage_skill" || (action.type === "choose_mcp" && action.choice === "skip");
    const canonicalAction = followUp && draft.interview && strictSelection
      ? { ...action, selection: strictSelection }
      : "selection" in action && action.selection
        ? { ...action, selection: canonicalSetupSelection(action.selection) }
        : action;
    const body = {
      baseRevision: draft.revision,
      clientRequestId: requestId(JSON.stringify([draft.revision, canonicalAction])),
      action: canonicalAction,
    };
    const accepted = await run((signal) =>
      client.patch(`/api/chats/${encodeURIComponent(draft.chatId)}/project-setup`, body, signal),
    );
    if (accepted) attempt.current = null;
    return accepted;
  };
  const draft = currentState.draft;
  const pendingService = draft?.mcp.state === "pending" ? draft.mcp.service : undefined;
  const mcpReviewKey = pendingService ? JSON.stringify([identity, pendingService]) : null;
  const mcpHandoff = Boolean(mcpReviewKey && (draft?.interview
    ? draft.interview.mcpHandoff
    : draft?.step === "review" && reviewMcpKey !== mcpReviewKey && !draft.generation));
  const continueToReview = async () => {
    if (!mcpHandoff || !await dispatch({ type: "prepare_review" })) return false;
    setReviewMcpKey(mcpReviewKey);
    return true;
  };
  const active = Boolean(draft && draft.step !== "saved");
  const waiting = waitingForSetupReply(draft);
  const [exhaustedGeneration, setExhaustedGeneration] = useState<string | null>(null);
  const pollingGeneration = eligible && waiting
    ? JSON.stringify([identity, draft?.revision, draft?.generation?.runId])
    : null;
  const canAnswer = active && !currentState.pending && !waiting && !setupReplyFailed(draft)
    && (!mcpHandoff || Boolean(draft?.interview));
  const retryInterview = () =>
    strictSelection && setupReplyFailed(stateRef.current.draft)
      ? dispatch({ type: "interview_retry", selection: strictSelection })
      : Promise.resolve(false);
  const syncGeneration = useEffectEvent(() => {
    if (!request.current) void dispatch({ type: "sync_generation" });
  });
  useEffect(() => {
    if (!pollingGeneration) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (attempts >= 60) {
        window.clearInterval(timer);
        setExhaustedGeneration(pollingGeneration);
        return;
      }
      attempts += 1;
      syncGeneration();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [pollingGeneration]);

  const answer = async (text: string): Promise<boolean> => {
    const current = stateRef.current.draft;
    const reply = text.trim();
    if (!current || !reply || !canAnswer || waitingForSetupReply(current) || setupReplyFailed(current)) return false;
    if (current.interview)
      return dispatch({ type: "interview_answer", text: reply, ...(strictSelection ? { selection: strictSelection } : {}) });
    if (current.step === "review")
      return dispatch({ type: "revise", field: "guidance", text: text.trim() });
    return dispatch({ type: "answer", text: reply });
  };
  const dismiss = () => {
    request.current?.abort();
    request.current = null;
    setState((previous) => ({ ...previous, identity, introduction: false, pending: false, error: null }));
  };
  return {
    ...currentState,
    eligible,
    start,
    dismiss,
    answer,
    mcpHandoff,
    continueToReview,
    dispatch,
    reload,
    active,
    canAnswer,
    replyPollingExhausted: Boolean(pollingGeneration && pollingGeneration === exhaustedGeneration),
    retryInterview,
  };
}
export type ProjectSetupController = ReturnType<typeof useProjectSetup>;

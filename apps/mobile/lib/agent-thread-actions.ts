import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as Haptics from "expo-haptics";
import type { AgentThreadEvent, AgentThreadSnapshot, ApprovalDecisionRequest } from "@matrix-os/contracts";
import type { GatewayClient } from "./gateway-client";

export type AgentThreadRouteState =
  | { status: "loading"; snapshot: null; error: null }
  | { status: "ready"; snapshot: AgentThreadSnapshot; error: "Thread state unavailable" | null; refreshing: boolean }
  | { status: "error"; snapshot: null; error: "Thread state unavailable" };

export type ThreadActionError =
  | "Approval could not be sent. Try again."
  | "Input could not be sent. Try again.";

type PendingAcceptedThreadAction = {
  threadId: string;
  snapshotKey: string;
  inputRequestId: string | null;
};

type UseAgentThreadActionsOptions = {
  client: GatewayClient | null;
  state: AgentThreadRouteState;
  setState: Dispatch<SetStateAction<AgentThreadRouteState>>;
  routeThreadId: string;
  requestGeneration: MutableRefObject<number>;
};

function notifySuccessfulThreadAction(): void {
  void Promise.resolve(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
    .catch((err: unknown) => {
      console.warn("[mobile] thread action haptic failed", err instanceof Error ? err.message : String(err));
    });
}

export function threadSnapshotFeedbackKey(snapshot: AgentThreadSnapshot): string {
  const lastEventId = snapshot.events.items.at(-1)?.eventId ?? "none";
  return `${snapshot.thread.id}:${snapshot.thread.updatedAt}:${snapshot.events.items.length}:${lastEventId}`;
}

function createMobileClientRequestId(): `req_${string}` {
  const random = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `req_mobile_${Date.now().toString(36)}_${random}`;
}

export function useAgentThreadActions({
  client,
  state,
  setState,
  routeThreadId,
  requestGeneration,
}: UseAgentThreadActionsOptions) {
  const [pendingActionIds, setPendingActionIds] = useState<Record<string, true>>({});
  const [threadActionErrors, setThreadActionErrors] = useState<Record<string, ThreadActionError>>({});
  const [inputAnswers, setInputAnswers] = useState<Record<string, string>>({});
  const pendingActionKeysRef = useRef<Record<string, true>>({});
  const mountedRef = useRef(true);
  const routeThreadIdRef = useRef(routeThreadId);
  const pendingAcceptedActionRef = useRef<PendingAcceptedThreadAction | null>(null);
  routeThreadIdRef.current = routeThreadId;

  const resetThreadActionErrors = useCallback(() => {
    setThreadActionErrors({});
  }, []);

  const applyThreadActionSnapshot = useCallback((
    snapshot: AgentThreadSnapshot,
    options: { inputRequestId?: string } = {},
  ) => {
    if (!mountedRef.current || routeThreadIdRef.current !== snapshot.thread.id) return;
    setState((current) => {
      if (!mountedRef.current || current.status !== "ready" || current.snapshot.thread.id !== snapshot.thread.id) {
        return current;
      }
      requestGeneration.current += 1;
      pendingAcceptedActionRef.current = {
        threadId: snapshot.thread.id,
        snapshotKey: threadSnapshotFeedbackKey(snapshot),
        inputRequestId: options.inputRequestId ?? null,
      };
      return { ...current, snapshot, error: null, refreshing: false };
    });
  }, [requestGeneration, setState]);

  useEffect(() => {
    const pending = pendingAcceptedActionRef.current;
    if (!pending) return;
    if (routeThreadIdRef.current !== pending.threadId) {
      pendingAcceptedActionRef.current = null;
      return;
    }
    if (state.status !== "ready" || state.snapshot.thread.id !== pending.threadId) return;
    if (threadSnapshotFeedbackKey(state.snapshot) !== pending.snapshotKey) {
      pendingAcceptedActionRef.current = null;
      return;
    }
    pendingAcceptedActionRef.current = null;
    if (pending.inputRequestId) {
      const inputRequestId = pending.inputRequestId;
      setInputAnswers((current) => {
        const next = { ...current };
        delete next[inputRequestId];
        return next;
      });
    }
    notifySuccessfulThreadAction();
  }, [state]);

  useEffect(() => () => {
    mountedRef.current = false;
    pendingAcceptedActionRef.current = null;
  }, []);

  const submitApprovalDecision = useCallback(async (
    event: Extract<AgentThreadEvent, { type: "approval.requested" }>,
    decision: ApprovalDecisionRequest["decision"],
  ) => {
    if (!client || state.status !== "ready") return;
    const actionGroupId = `approval:${event.approval.approvalId}`;
    if (pendingActionKeysRef.current[actionGroupId]) return;
    pendingActionKeysRef.current[actionGroupId] = true;
    const actionId = `${event.approval.approvalId}:${decision}`;
    setPendingActionIds((current) => ({ ...current, [actionId]: true }));
    setThreadActionErrors((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
    let result: Awaited<ReturnType<NonNullable<typeof client>["submitCodingAgentApprovalDecision"]>>;
    try {
      result = await client.submitCodingAgentApprovalDecision({
        threadId: state.snapshot.thread.id,
        approvalId: event.approval.approvalId,
        decision,
        correlationId: event.approval.correlationId,
        clientRequestId: createMobileClientRequestId(),
      });
    } catch {
      result = { ok: false, error: "Approval could not be sent. Try again." };
    } finally {
      setPendingActionIds((current) => {
        const next = { ...current };
        delete next[actionId];
        return next;
      });
      delete pendingActionKeysRef.current[actionGroupId];
    }
    if (result.ok) {
      applyThreadActionSnapshot(result.snapshot);
      return;
    }
    setThreadActionErrors((current) => ({
      ...current,
      [actionId]: "Approval could not be sent. Try again.",
    }));
  }, [applyThreadActionSnapshot, client, state]);

  const setInputAnswer = useCallback((requestId: string, answer: string) => {
    setInputAnswers((current) => ({
      ...current,
      [requestId]: answer,
    }));
  }, []);

  const submitInputAnswer = useCallback(async (
    event: Extract<AgentThreadEvent, { type: "user_input.requested" }>,
  ) => {
    if (!client || state.status !== "ready") return;
    const answer = inputAnswers[event.request.requestId] ?? "";
    if (!answer.trim()) return;
    const actionGroupId = `input:${event.request.requestId}`;
    if (pendingActionKeysRef.current[actionGroupId]) return;
    pendingActionKeysRef.current[actionGroupId] = true;
    const actionId = `${event.request.requestId}:answer`;
    setPendingActionIds((current) => ({ ...current, [actionId]: true }));
    setThreadActionErrors((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
    let result: Awaited<ReturnType<NonNullable<typeof client>["submitCodingAgentInputAnswer"]>>;
    try {
      result = await client.submitCodingAgentInputAnswer({
        threadId: state.snapshot.thread.id,
        inputRequestId: event.request.requestId,
        answer,
        correlationId: event.request.correlationId,
        clientRequestId: createMobileClientRequestId(),
      });
    } catch {
      result = { ok: false, error: "Input could not be sent. Try again." };
    } finally {
      setPendingActionIds((current) => {
        const next = { ...current };
        delete next[actionId];
        return next;
      });
      delete pendingActionKeysRef.current[actionGroupId];
    }
    if (result.ok) {
      applyThreadActionSnapshot(result.snapshot, { inputRequestId: event.request.requestId });
      return;
    }
    setThreadActionErrors((current) => ({
      ...current,
      [actionId]: "Input could not be sent. Try again.",
    }));
  }, [applyThreadActionSnapshot, client, inputAnswers, state]);

  return {
    inputAnswers,
    pendingActionIds,
    resetThreadActionErrors,
    setInputAnswer,
    submitApprovalDecision,
    submitInputAnswer,
    threadActionErrors,
  };
}

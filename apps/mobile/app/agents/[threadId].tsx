import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, AppState, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { AgentThreadEvent, AgentThreadSnapshot, AgentThreadSummary, ApprovalDecisionRequest } from "@matrix-os/contracts";
import { useGateway } from "@/app/_layout";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";
import { isSafeShellSessionName } from "@/lib/terminal-state";

type ThreadRouteState =
  | { status: "loading"; snapshot: null; error: null }
  | { status: "ready"; snapshot: AgentThreadSnapshot; error: "Thread state unavailable" | null; refreshing: boolean }
  | { status: "error"; snapshot: null; error: "Thread state unavailable" };

type TerminalOpenError = "Terminal session unavailable. Try again.";
type ThreadActionError =
  | "Approval could not be sent. Try again."
  | "Input could not be sent. Try again.";

export default function AgentThreadRoute() {
  const { theme } = useUnistyles();
  const params = useLocalSearchParams<{ threadId?: string }>();
  const router = useRouter();
  const threadId = typeof params.threadId === "string" ? params.threadId : "thread";
  const { client } = useGateway();
  const requestGeneration = useRef(0);
  const [state, setState] = useState<ThreadRouteState>({
    status: "loading",
    snapshot: null,
    error: null,
  });
  const [terminalOpenError, setTerminalOpenError] = useState<TerminalOpenError | null>(null);
  const [pendingActionIds, setPendingActionIds] = useState<Record<string, true>>({});
  const [threadActionErrors, setThreadActionErrors] = useState<Record<string, ThreadActionError>>({});
  const [inputAnswers, setInputAnswers] = useState<Record<string, string>>({});
  const streamSubscriptionRef = useRef<{ detach(): void } | null>(null);
  const streamGenerationRef = useRef(0);

  const invalidateSnapshotRequests = useCallback(() => {
    requestGeneration.current += 1;
  }, []);

  const attachThreadStream = useCallback((snapshot: AgentThreadSnapshot) => {
    streamGenerationRef.current += 1;
    const streamGeneration = streamGenerationRef.current;
    streamSubscriptionRef.current?.detach();
    streamSubscriptionRef.current = null;
    if (!client || !threadId) return;
    const subscribe = client.subscribeCodingAgentThreadEvents;
    if (typeof subscribe !== "function") return;
    const cursor = snapshot.events.nextCursor ?? snapshot.events.items.at(-1)?.eventId;
    const handleStreamUnavailable = () => {
      console.warn("[mobile] coding-agent thread stream unavailable");
      if (streamGeneration !== streamGenerationRef.current) return;
      setState((current) => current.status === "ready"
        ? { ...current, error: "Thread state unavailable", refreshing: false }
        : current);
    };

    try {
      const subscriptionPromise = subscribe.call(client, {
        threadId,
        cursor,
        onEvent: (event: AgentThreadEvent) => {
          if (streamGeneration !== streamGenerationRef.current) return;
          setState((current) => current.status === "ready"
            ? { ...current, snapshot: mergeLiveThreadEvent(current.snapshot, event), error: null, refreshing: false }
            : current);
        },
        onError: handleStreamUnavailable,
      });
      void Promise.resolve(subscriptionPromise).then((subscription) => {
        if (streamGeneration !== streamGenerationRef.current) {
          subscription?.detach();
          return;
        }
        streamSubscriptionRef.current = subscription;
      }).catch(handleStreamUnavailable);
    } catch {
      handleStreamUnavailable();
    }
  }, [client, threadId]);

  const loadSnapshot = useCallback(async (cancelled: () => boolean = () => false) => {
    setTerminalOpenError(null);
    setThreadActionErrors({});
    if (!client || !threadId) {
      setState((current) => current.status === "ready"
        ? { ...current, error: "Thread state unavailable", refreshing: false }
        : { status: "error", snapshot: null, error: "Thread state unavailable" });
      return;
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setState((current) => current.status === "ready"
      ? { ...current, error: null, refreshing: true }
      : { status: "loading", snapshot: null, error: null });
    const result = await client.getCodingAgentThreadSnapshot({ threadId });
    if (cancelled() || generation !== requestGeneration.current) return;
    if (result.ok) {
      setState({ status: "ready", snapshot: result.snapshot, error: null, refreshing: false });
      attachThreadStream(result.snapshot);
      return;
    }
    setState((current) => current.status === "ready"
      ? { ...current, error: "Thread state unavailable", refreshing: false }
      : { status: "error", snapshot: null, error: "Thread state unavailable" });
  }, [attachThreadStream, client, threadId]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadSnapshot(() => cancelled);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && client) {
        void loadSnapshot(() => cancelled);
      }
    });
    return () => {
      cancelled = true;
      subscription?.remove?.();
    };
  }, [client, loadSnapshot]);

  useEffect(() => () => {
    streamGenerationRef.current += 1;
    streamSubscriptionRef.current?.detach();
    streamSubscriptionRef.current = null;
  }, []);

  const submitApprovalDecision = useCallback(async (
    event: Extract<AgentThreadEvent, { type: "approval.requested" }>,
    decision: ApprovalDecisionRequest["decision"],
  ) => {
    if (!client || state.status !== "ready") return;
    const actionId = `${event.approval.approvalId}:${decision}`;
    setPendingActionIds((current) => ({ ...current, [actionId]: true }));
    setThreadActionErrors((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
    const result = await client.submitCodingAgentApprovalDecision({
      threadId: state.snapshot.thread.id,
      approvalId: event.approval.approvalId,
      decision,
      correlationId: event.approval.correlationId,
      clientRequestId: createMobileClientRequestId(),
    });
    setPendingActionIds((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
    if (result.ok) {
      invalidateSnapshotRequests();
      setState((current) => current.status === "ready"
        ? { ...current, snapshot: result.snapshot, error: null, refreshing: false }
        : current);
      return;
    }
    setThreadActionErrors((current) => ({
      ...current,
      [actionId]: "Approval could not be sent. Try again.",
    }));
  }, [client, invalidateSnapshotRequests, state]);

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
    const actionId = `${event.request.requestId}:answer`;
    setPendingActionIds((current) => ({ ...current, [actionId]: true }));
    setThreadActionErrors((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
    const result = await client.submitCodingAgentInputAnswer({
      threadId: state.snapshot.thread.id,
      inputRequestId: event.request.requestId,
      answer,
      correlationId: event.request.correlationId,
      clientRequestId: createMobileClientRequestId(),
    });
    setPendingActionIds((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
    if (result.ok) {
      invalidateSnapshotRequests();
      setInputAnswers((current) => {
        const next = { ...current };
        delete next[event.request.requestId];
        return next;
      });
      setState((current) => current.status === "ready"
        ? { ...current, snapshot: result.snapshot, error: null, refreshing: false }
        : current);
      return;
    }
    setThreadActionErrors((current) => ({
      ...current,
      [actionId]: "Input could not be sent. Try again.",
    }));
  }, [client, inputAnswers, invalidateSnapshotRequests, state]);

  const boundTerminalSessionId = state.status === "ready" ? state.snapshot.thread.terminalSessionId ?? null : null;
  const openBoundTerminal = useCallback(async () => {
    if (!boundTerminalSessionId) return;
    setTerminalOpenError(null);
    if (!isSafeShellSessionName(boundTerminalSessionId)) {
      setTerminalOpenError("Terminal session unavailable. Try again.");
      return;
    }
    try {
      const savedState = await loadMobileShellState();
      await saveMobileShellState({
        ...savedState,
        mode: "terminal",
        lastActiveTerminalSessionId: boundTerminalSessionId,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      console.warn("[mobile] failed to remember bound terminal session");
      setTerminalOpenError("Terminal session unavailable. Try again.");
      return;
    }
    router.push("/terminal");
  }, [boundTerminalSessionId, router]);

  const openThreadFollowUp = useCallback(() => {
    if (state.status !== "ready") return;
    router.push({
      pathname: "/agents/new",
      params: {
        sourceThreadId: state.snapshot.thread.id,
        sourceThreadTitle: state.snapshot.thread.title,
        sourceProviderId: state.snapshot.thread.providerId,
      },
    });
  }, [router, state]);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.forest} />
        <Text style={styles.title}>Loading thread...</Text>
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.centered}>
        <Ionicons name="warning-outline" size={28} color={theme.colors.moss} />
        <Text style={styles.title}>{state.error}</Text>
        <Text style={styles.body}>Refresh the workspace or open the thread again.</Text>
      </View>
    );
  }

  const { thread, events } = state.snapshot;
  const terminalSessionId = thread.terminalSessionId ?? "No terminal bound";
  const attention = threadAttentionCopy(thread.attention);
  const resolvedApprovalIds = new Set(events.items
    .filter((event): event is Extract<AgentThreadEvent, { type: "approval.resolved" }> => event.type === "approval.resolved")
    .map((event) => event.approvalId));
  const answeredInputRequestIds = new Set(events.items
    .filter((event): event is Extract<AgentThreadEvent, { type: "user_input.answered" }> => event.type === "user_input.answered")
    .map((event) => event.requestId));

  return (
    <ScrollView
      style={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
    >
      <View style={styles.panel}>
        <View style={styles.headerRow}>
          <View style={styles.threadIcon}>
            <Ionicons name="git-branch-outline" size={18} color={theme.colors.moss} />
          </View>
          <View style={styles.headerText}>
            <Text selectable style={styles.title}>{thread.title}</Text>
            <Text selectable style={styles.body}>{thread.providerId}</Text>
          </View>
          <Text style={styles.status}>{thread.status.replace(/_/g, " ")}</Text>
        </View>
        <View style={styles.metaGrid}>
          <MetaItem label="Thread" value={thread.id} />
          <MetaItem label="Terminal" value={terminalSessionId} />
          <MetaItem label="Updated" value={thread.updatedAt} />
          <MetaItem label="Activity" value={`${events.items.length} ${events.items.length === 1 ? "event" : "events"}`} />
        </View>
        {events.hasMore ? (
          <Text style={styles.body}>Older activity is available from the runtime.</Text>
        ) : null}
        {attention ? (
          <View style={styles.attentionBanner}>
            <Ionicons name={attention.icon} size={16} color={theme.colors.moss} />
            <View style={styles.attentionText}>
              <Text style={styles.attentionTitle}>{attention.title}</Text>
              <Text style={styles.attentionDetail}>{attention.detail}</Text>
            </View>
          </View>
        ) : null}
        {state.error ? (
          <Text style={styles.inlineError}>{state.error}</Text>
        ) : null}
        {terminalOpenError ? (
          <Text style={styles.inlineError}>{terminalOpenError}</Text>
        ) : null}
        <View style={styles.actionRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ask follow-up about this thread"
            onPress={openThreadFollowUp}
            style={styles.secondaryButton}
          >
            <Ionicons name="chatbubble-ellipses-outline" size={16} color={theme.colors.forest} />
            <Text style={styles.secondaryText}>Follow up</Text>
          </Pressable>
          {thread.terminalSessionId ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open bound terminal"
              onPress={() => void openBoundTerminal()}
              style={styles.secondaryButton}
            >
              <Ionicons name="terminal-outline" size={16} color={theme.colors.forest} />
              <Text style={styles.secondaryText}>Terminal</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh thread"
            onPress={() => void loadSnapshot()}
            style={styles.refreshButton}
          >
            <Ionicons name="refresh-outline" size={16} color={theme.colors.background} />
            <Text style={styles.refreshText}>{state.refreshing ? "Refreshing" : "Refresh"}</Text>
          </Pressable>
        </View>
      </View>
      {events.items.length > 0 ? (
        <View style={styles.timeline}>
          <Text style={styles.sectionTitle}>Activity timeline</Text>
          {events.items.map((event) => (
            <ThreadEventItem
              key={event.eventId}
              event={event}
              pendingActionIds={pendingActionIds}
              actionErrors={threadActionErrors}
              resolved={event.type === "approval.requested"
                ? resolvedApprovalIds.has(event.approval.approvalId)
                : event.type === "user_input.requested" && answeredInputRequestIds.has(event.request.requestId)}
              inputAnswer={event.type === "user_input.requested" ? inputAnswers[event.request.requestId] ?? "" : ""}
              onInputAnswerChange={setInputAnswer}
              onInputAnswerSubmit={submitInputAnswer}
              onApprovalDecision={submitApprovalDecision}
            />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

function mergeLiveThreadEvent(snapshot: AgentThreadSnapshot, event: AgentThreadEvent): AgentThreadSnapshot {
  if (event.threadId !== snapshot.thread.id) return snapshot;
  if (snapshot.events.items.some((item) => item.eventId === event.eventId)) return snapshot;
  const limit = snapshot.events.limit;
  const items = [...snapshot.events.items, event]
    .sort(compareThreadEvents)
    .slice(-limit);
  return {
    ...snapshot,
    thread: deriveLiveThreadSummary(snapshot.thread, items, event),
    events: {
      ...snapshot.events,
      items,
      nextCursor: event.eventId,
    },
  };
}

function compareThreadEvents(a: AgentThreadEvent, b: AgentThreadEvent): number {
  const byOccurredAt = a.occurredAt.localeCompare(b.occurredAt);
  if (byOccurredAt !== 0) return byOccurredAt;
  return a.eventId.localeCompare(b.eventId);
}

function deriveLiveThreadSummary(
  baseThread: AgentThreadSummary,
  events: AgentThreadEvent[],
  event: AgentThreadEvent,
): AgentThreadSummary {
  const thread: AgentThreadSummary = {
    ...baseThread,
    updatedAt: latestIsoTimestamp(baseThread.updatedAt, event.occurredAt),
  };
  switch (event.type) {
    case "thread.created":
      return event.occurredAt.localeCompare(baseThread.updatedAt) >= 0
        ? { ...event.thread, updatedAt: event.occurredAt }
        : thread;
    case "thread.status":
      return {
        ...thread,
        status: event.status,
        attention: attentionForThreadStatus(event.status),
      };
    case "terminal.bound":
      return { ...thread, terminalSessionId: event.terminalSessionId };
    case "approval.requested":
      if (isTerminalThreadStatus(thread.status) || hasResolvedApproval(events, event)) return thread;
      return { ...thread, status: "waiting_for_approval", attention: "approval_required" };
    case "approval.resolved":
      return { ...thread, status: "running", attention: "none" };
    case "user_input.requested":
      if (isTerminalThreadStatus(thread.status) || hasAnsweredInput(events, event)) return thread;
      return { ...thread, status: "waiting_for_input", attention: "input_required" };
    case "user_input.answered":
      return { ...thread, status: "running", attention: "none" };
    case "thread.error":
      return { ...thread, status: "failed", attention: "failed" };
    case "thread.completed":
      return {
        ...thread,
        status: event.outcome,
        attention: event.outcome === "completed" ? "completed" : event.outcome === "failed" ? "failed" : "none",
      };
    default:
      return thread;
  }
}

function latestIsoTimestamp(a: string, b: string): string {
  return a.localeCompare(b) >= 0 ? a : b;
}

function hasResolvedApproval(
  events: AgentThreadEvent[],
  requestEvent: Extract<AgentThreadEvent, { type: "approval.requested" }>,
): boolean {
  return events.some((event) => event.type === "approval.resolved"
    && event.approvalId === requestEvent.approval.approvalId
    && event.occurredAt.localeCompare(requestEvent.occurredAt) >= 0);
}

function hasAnsweredInput(
  events: AgentThreadEvent[],
  requestEvent: Extract<AgentThreadEvent, { type: "user_input.requested" }>,
): boolean {
  return events.some((event) => event.type === "user_input.answered"
    && event.requestId === requestEvent.request.requestId
    && event.occurredAt.localeCompare(requestEvent.occurredAt) >= 0);
}

function attentionForThreadStatus(status: AgentThreadSummary["status"]): AgentThreadSummary["attention"] {
  switch (status) {
    case "waiting_for_approval":
      return "approval_required";
    case "waiting_for_input":
      return "input_required";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    default:
      return "none";
  }
}

function isTerminalThreadStatus(status: AgentThreadSummary["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted" || status === "archived";
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text selectable style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function ThreadEventItem({
  event,
  pendingActionIds,
  actionErrors,
  resolved,
  inputAnswer,
  onInputAnswerChange,
  onInputAnswerSubmit,
  onApprovalDecision,
}: {
  event: AgentThreadEvent;
  pendingActionIds: Record<string, true>;
  actionErrors: Record<string, ThreadActionError>;
  resolved: boolean;
  inputAnswer: string;
  onInputAnswerChange: (requestId: string, answer: string) => void;
  onInputAnswerSubmit: (event: Extract<AgentThreadEvent, { type: "user_input.requested" }>) => void;
  onApprovalDecision: (
    event: Extract<AgentThreadEvent, { type: "approval.requested" }>,
    decision: ApprovalDecisionRequest["decision"],
  ) => void;
}) {
  const { theme } = useUnistyles();
  const copy = describeThreadEvent(event);
  return (
    <View style={styles.eventRow}>
      <View style={styles.eventIcon}>
        <Ionicons name={copy.icon} size={14} color={theme.colors.moss} />
      </View>
      <View style={styles.eventText}>
        <Text style={styles.eventTitle}>{copy.title}</Text>
        <Text selectable style={styles.eventDetail}>{copy.detail}</Text>
        {event.type === "approval.requested" && !resolved ? (
          <View style={styles.inlineActionGroup}>
            {event.approval.allowedDecisions.map((decision) => {
              const label = formatApprovalDecision(decision);
              const actionId = `${event.approval.approvalId}:${decision}`;
              const pending = Boolean(pendingActionIds[actionId]);
              const rowPending = event.approval.allowedDecisions.some((allowedDecision) =>
                Boolean(pendingActionIds[`${event.approval.approvalId}:${allowedDecision}`]));
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${label} ${event.approval.title}`}
                  disabled={rowPending}
                  key={decision}
                  onPress={() => onApprovalDecision(event, decision)}
                  style={[
                    decision === "approve" || decision === "approve_for_session"
                      ? styles.inlinePrimaryButton
                      : styles.inlineSecondaryButton,
                    pending ? styles.inlineButtonDisabled : null,
                  ]}
                >
                  <Text
                    style={decision === "approve" || decision === "approve_for_session"
                      ? styles.inlinePrimaryButtonText
                      : styles.inlineSecondaryButtonText}
                  >
                    {pending ? "Sending" : label}
                  </Text>
                </Pressable>
              );
            })}
            {findApprovalActionError(event, actionErrors) ? (
              <Text style={styles.inlineError}>{findApprovalActionError(event, actionErrors)}</Text>
            ) : null}
          </View>
        ) : null}
        {event.type === "user_input.requested" && !resolved ? (
          <View style={styles.inputComposer}>
            <TextInput
              accessibilityLabel={`Answer ${event.request.title}`}
              multiline
              numberOfLines={3}
              onChangeText={(value) => onInputAnswerChange(event.request.requestId, value)}
              placeholder={event.request.placeholder ?? "Answer"}
              placeholderTextColor={theme.colors.mutedForeground}
              style={styles.inputField}
              value={inputAnswer}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Send ${event.request.title}`}
              disabled={Boolean(pendingActionIds[`${event.request.requestId}:answer`]) || !inputAnswer.trim()}
              onPress={() => onInputAnswerSubmit(event)}
              style={[
                styles.inlinePrimaryButton,
                Boolean(pendingActionIds[`${event.request.requestId}:answer`]) || !inputAnswer.trim()
                  ? styles.inlineButtonDisabled
                  : null,
              ]}
            >
              <Text style={styles.inlinePrimaryButtonText}>
                {pendingActionIds[`${event.request.requestId}:answer`] ? "Sending" : "Send"}
              </Text>
            </Pressable>
            {actionErrors[`${event.request.requestId}:answer`] ? (
              <Text style={styles.inlineError}>{actionErrors[`${event.request.requestId}:answer`]}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function describeThreadEvent(event: AgentThreadEvent): { icon: keyof typeof Ionicons.glyphMap; title: string; detail: string } {
  switch (event.type) {
    case "thread.created":
      return { icon: "sparkles-outline", title: "Thread created", detail: event.thread.title };
    case "thread.status":
      return { icon: "pulse-outline", title: "Status changed", detail: event.status.replace(/_/g, " ") };
    case "assistant.text.delta":
      return { icon: "chatbubble-ellipses-outline", title: "Assistant update", detail: "Text update received" };
    case "assistant.text.completed":
      return { icon: "checkmark-circle-outline", title: "Assistant message complete", detail: event.messageId };
    case "tool.started":
      return { icon: "hammer-outline", title: "Tool started", detail: event.displayName };
    case "tool.output":
      return {
        icon: "document-text-outline",
        title: "Tool output",
        detail: event.truncated ? "Output received, partial" : "Output received",
      };
    case "tool.completed":
      return { icon: "checkmark-done-outline", title: "Tool completed", detail: event.outcome };
    case "approval.requested":
      return { icon: "shield-checkmark-outline", title: "Approval needed", detail: event.approval.safeDescription };
    case "approval.resolved":
      return { icon: "shield-outline", title: "Approval resolved", detail: event.decision };
    case "user_input.requested":
      return { icon: "create-outline", title: "Input needed", detail: event.request.safeDescription };
    case "user_input.answered":
      return { icon: "return-down-forward-outline", title: "Input answered", detail: event.requestId };
    case "file.changed":
      return { icon: "document-outline", title: `File ${event.changeKind}`, detail: `${capitalize(event.changeKind)} file` };
    case "review.ready": {
      const files = `${event.summary.changedFileCount} ${event.summary.changedFileCount === 1 ? "file" : "files"} changed`;
      const partial = event.summary.partial ? ", partial" : "";
      return {
        icon: "git-pull-request-outline",
        title: "Review ready",
        detail: `${files}, +${event.summary.additions} -${event.summary.deletions}${partial}`,
      };
    }
    case "terminal.bound":
      return { icon: "terminal-outline", title: "Terminal bound", detail: event.terminalSessionId };
    case "thread.error":
      return {
        icon: "warning-outline",
        title: "Thread needs attention",
        detail: event.error.retryable ? "Refresh the thread or check the runtime." : "Open the workspace again.",
      };
    case "thread.completed":
      return { icon: "flag-outline", title: "Thread completed", detail: event.outcome };
  }
}

function threadAttentionCopy(attention?: string): { icon: keyof typeof Ionicons.glyphMap; title: string; detail: string } | null {
  switch (attention) {
    case "approval_required":
      return {
        icon: "shield-checkmark-outline",
        title: "Approval needed",
        detail: "Review the request and choose a safe decision.",
      };
    case "input_required":
      return {
        icon: "create-outline",
        title: "Input needed",
        detail: "Answer the prompt to keep this run moving.",
      };
    case "failed":
      return {
        icon: "warning-outline",
        title: "Run failed",
        detail: "Open the thread activity or start a follow-up run.",
      };
    default:
      return null;
  }
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatApprovalDecision(decision: ApprovalDecisionRequest["decision"]): string {
  switch (decision) {
    case "approve":
      return "Approve";
    case "approve_for_session":
      return "Approve for session";
    case "decline":
      return "Decline";
    case "cancel":
      return "Cancel";
  }
}

function findApprovalActionError(
  event: Extract<AgentThreadEvent, { type: "approval.requested" }>,
  actionErrors: Record<string, ThreadActionError>,
): ThreadActionError | null {
  for (const decision of event.approval.allowedDecisions) {
    const error = actionErrors[`${event.approval.approvalId}:${decision}`];
    if (error) return error;
  }
  return null;
}

function createMobileClientRequestId(): `req_${string}` {
  const random = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `req_mobile_${Date.now().toString(36)}_${random}`;
}

const styles = StyleSheet.create((theme, rt) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingTop: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: rt.insets.bottom + 32,
  },
  panel: {
    borderRadius: 16,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  threadIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 17,
    color: theme.colors.foreground,
  },
  body: {
    fontFamily: theme.fonts.mono,
    fontSize: 13,
    color: theme.colors.mutedForeground,
  },
  status: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.forest,
  },
  metaGrid: {
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  metaItem: {
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.md,
    gap: 2,
  },
  metaLabel: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  metaValue: {
    fontFamily: theme.fonts.mono,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  actionRow: {
    marginTop: theme.spacing.sm,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  refreshButton: {
    flexGrow: 1,
    minHeight: 40,
    borderRadius: 20,
    paddingHorizontal: theme.spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.forest,
  },
  refreshText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.background,
  },
  secondaryButton: {
    minHeight: 40,
    borderRadius: 20,
    paddingHorizontal: theme.spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secondaryText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.forest,
  },
  inlineError: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.moss,
  },
  attentionBanner: {
    marginTop: theme.spacing.sm,
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.md,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.sm,
  },
  attentionText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  attentionTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  attentionDetail: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  timeline: {
    marginTop: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  sectionTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  eventRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.sm,
  },
  eventIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  eventText: {
    flex: 1,
    minWidth: 0,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: 2,
  },
  eventTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  eventDetail: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  inlineActionGroup: {
    marginTop: theme.spacing.sm,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    alignItems: "center",
  },
  inlinePrimaryButton: {
    minHeight: 36,
    borderRadius: 18,
    paddingHorizontal: theme.spacing.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.forest,
  },
  inlinePrimaryButtonText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.background,
  },
  inlineSecondaryButton: {
    minHeight: 36,
    borderRadius: 18,
    paddingHorizontal: theme.spacing.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  inlineSecondaryButtonText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.forest,
  },
  inlineButtonDisabled: {
    opacity: 0.55,
  },
  inputComposer: {
    marginTop: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  inputField: {
    minHeight: 84,
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    color: theme.colors.foreground,
    textAlignVertical: "top",
  },
}));

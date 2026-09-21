import {
  CollaborationScopeSchema,
  type CollaborationAiRequest,
  type CollaborationApproval,
} from "@matrix-os/contracts/collaboration";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { z } from "zod/v4";
import {
  canControlSharedAiRequest,
  deriveSharedChatComposerPresentation,
  shouldShowSharedAiQueue,
} from "./shared-chat-composer-model";

type Scope = z.infer<typeof CollaborationScopeSchema>;
type ApprovalDecision = "approve" | "approve_for_session" | "decline" | "cancel";

export type SharedChatComposerState = {
  scope: Scope | null;
  aiAvailability: "checking" | "available" | "unavailable" | "owner_reconnect_required";
  aiRequests: CollaborationAiRequest[];
  approvals: CollaborationApproval[];
  aiDraft: string;
  sending: boolean;
  error: string;
  aiError: string;
};

export function SharedChatComposer({ state, actorId, onDraftChange, onRequestAi,
  onControlAi, onDecideApproval }: {
  state: SharedChatComposerState;
  actorId: string;
  onDraftChange: (text: string) => void;
  onRequestAi: () => Promise<void>;
  onControlAi: (request: CollaborationAiRequest, action: "cancel" | "retry") => Promise<void>;
  onDecideApproval: (approval: CollaborationApproval, decision: ApprovalDecision) => Promise<void>;
}) {
  const presentation = deriveSharedChatComposerPresentation(state);
  return <View style={styles.composer}>
    {presentation.status ? <Text accessibilityRole="text" style={styles.muted}>{presentation.status}</Text> : null}
    {shouldShowSharedAiQueue(state) ? <SharedAiQueue state={state} actorId={actorId}
      onControlAi={onControlAi} onDecideApproval={onDecideApproval} /> : null}
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text> : null}
    {state.aiError ? <Text accessibilityRole="alert" style={styles.error}>{state.aiError}</Text> : null}
    <TextInput accessibilityLabel={presentation.inputLabel} multiline value={presentation.value}
      editable={presentation.canWrite && !state.sending} onChangeText={onDraftChange}
      placeholder={presentation.placeholder} style={styles.input} />
    <Action label={state.sending ? "Sending…" : presentation.submitLabel}
      disabled={Boolean(!presentation.canWrite || state.sending || !presentation.value.trim())}
      onPress={() => void onRequestAi()} />
  </View>;
}

type SharedAiQueueRow =
  | { kind: "request"; request: CollaborationAiRequest }
  | { kind: "approval"; approval: CollaborationApproval };

function SharedAiQueue({ state, actorId, onControlAi, onDecideApproval }: {
  state: SharedChatComposerState;
  actorId: string;
  onControlAi: (request: CollaborationAiRequest, action: "cancel" | "retry") => Promise<void>;
  onDecideApproval: (approval: CollaborationApproval, decision: ApprovalDecision) => Promise<void>;
}) {
  const rows = sharedAiRows(state);
  return <View accessibilityLabel="Shared AI queue" style={styles.queue}>
    <Text style={styles.cardTitle}>AI requests · {state.aiRequests.length} accepted</Text>
    <View style={styles.queueContent}>{rows.map((row) => <SharedAiQueueRowView
      key={row.kind === "request" ? `request:${row.request.id}` : `approval:${row.approval.approvalId}`}
      row={row} role={state.scope?.role} actorId={actorId} sending={state.sending}
      onControlAi={onControlAi} onDecideApproval={onDecideApproval} />)}</View>
  </View>;
}

function SharedAiQueueRowView({ row, role, actorId, sending, onControlAi, onDecideApproval }: {
  row: SharedAiQueueRow;
  role: Scope["role"] | undefined;
  actorId: string;
  sending: boolean;
  onControlAi: (request: CollaborationAiRequest, action: "cancel" | "retry") => Promise<void>;
  onDecideApproval: (approval: CollaborationApproval, decision: ApprovalDecision) => Promise<void>;
}) {
  if (row.kind === "approval") return <ApprovalQueueRow approval={row.approval} sending={sending} onDecide={onDecideApproval} />;
  const { request } = row;
  const controllable = canControlSharedAiRequest(role, actorId, request);
  const cancellable = ["queued", "claimed", "running", "waiting_for_approval"].includes(request.state);
  const retryable = ["cancelled", "interrupted", "unauthorized", "unavailable"].includes(request.state);
  return <View style={styles.queueItem}>
    <Text style={styles.cardTitle}>{request.acceptedSequence} · {request.actor.displayName}</Text>
    <Text style={styles.muted}>{request.state.replaceAll("_", " ")} · {request.text}</Text>
    {controllable && cancellable ? <Action label={`Cancel request ${request.acceptedSequence}`}
      disabled={sending} onPress={() => void onControlAi(request, "cancel")} /> : null}
    {controllable && retryable ? <Action label={`Retry request ${request.acceptedSequence}`}
      disabled={sending} onPress={() => void onControlAi(request, "retry")} /> : null}
  </View>;
}

function ApprovalQueueRow({ approval, sending, onDecide }: {
  approval: CollaborationApproval;
  sending: boolean;
  onDecide: (approval: CollaborationApproval, decision: ApprovalDecision) => Promise<void>;
}) {
  return <View style={styles.queueItem}>
    <Text style={styles.cardTitle}>Approval needed: {approval.title}</Text>
    <Text style={styles.muted}>Risk: {approval.risk}</Text>
    {approval.allowedDecisions.map((decision) => <Action key={decision}
      label={`${decisionLabel(decision)} ${approval.title}`} disabled={sending}
      onPress={() => void onDecide(approval, decision)} />)}
  </View>;
}

function sharedAiRows(state: SharedChatComposerState): SharedAiQueueRow[] {
  const rows: SharedAiQueueRow[] = state.aiRequests
    .filter((request) => request.state !== "completed")
    .map((request) => ({ kind: "request", request }));
  if (state.scope?.role !== "owner") return rows;
  for (const approval of state.approvals) {
    if (approval.state === "pending") rows.push({ kind: "approval", approval });
  }
  return rows;
}

function Action({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, (pressed || disabled) && styles.faded]}>
    <Text style={styles.actionText}>{label}</Text>
  </Pressable>;
}

function decisionLabel(decision: ApprovalDecision): string {
  return decision === "approve_for_session" ? "Approve for session"
    : `${decision[0]!.toUpperCase()}${decision.slice(1)}`;
}

const styles = StyleSheet.create((theme) => ({
  composer: { gap: 8, padding: 16, borderTopWidth: 1, borderTopColor: theme.v2.colors.borderSubtle, backgroundColor: theme.v2.appColors.canvas },
  queue: { maxHeight: 240, gap: 8, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 14, padding: 12 },
  queueContent: { gap: 8 },
  queueItem: { gap: 6, borderTopWidth: 1, borderTopColor: theme.v2.colors.borderSubtle, paddingTop: 8 },
  input: { minHeight: 72, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 14, padding: 12, color: theme.v2.appColors.ink, fontFamily: theme.v2.fonts.body, textAlignVertical: "top" },
  action: { alignItems: "center", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: theme.v2.palette.green[800] },
  actionText: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.textInverse },
  cardTitle: { fontFamily: theme.v2.fonts.semibold, fontSize: 15, color: theme.v2.appColors.ink },
  muted: { fontFamily: theme.v2.fonts.body, fontSize: 13, lineHeight: 19, color: theme.v2.appColors.muted },
  error: { fontFamily: theme.v2.fonts.semibold, fontSize: 13, color: theme.v2.colors.textDefault },
  faded: { opacity: 0.55 },
}));

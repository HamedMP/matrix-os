import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAuth } from "@clerk/clerk-expo";
import {
  CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalSubmitChatApprovalRequestSchema,
  canonicalChatApprovalOutcome,
  supervisedToolApproval,
  type CanonicalChatApprovalDecision,
  type CanonicalChatApprovalView,
} from "@matrix-os/contracts";
import { palette } from "@/lib/theme";
import type { SupervisedToolApproval } from "@matrix-os/contracts";
import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

export function CanonicalApprovalMessage({ approval, chatId, gatewayUrl, permissionMode, onPermissionMode, onTryAgain, onSettled }: {
  approval: CanonicalChatApprovalView;
  chatId: string;
  gatewayUrl: string;
  permissionMode?: string;
  onPermissionMode?: (mode: "supervised" | "full_access") => void;
  onTryAgain?: () => void;
  onSettled: () => Promise<unknown> | void;
}) {
  const { getToken } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // At most four decision keys; preserve an ambiguous request's id on retry.
  const requestIds = useRef<Partial<Record<CanonicalChatApprovalDecision, string>>>({});
  async function submit(decision: CanonicalChatApprovalDecision) {
    const undo = supervisedToolApproval(approval)?.kind === "allowed" && decision === "decline";
    if (inFlight.current || submitted || (!approval.pending && !undo) || !approval.allowedDecisions.includes(decision)) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      const clientRequestId = requestIds.current[decision] ??= canonicalChatRequestId();
      const body = CanonicalSubmitChatApprovalRequestSchema.parse({ decision, clientRequestId,
        ...(approval.actionDigest !== undefined ? { actionDigest: approval.actionDigest } : {}) });
      await fetchAuthenticatedJson({
        url: buildGatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(chatId)}/runs/${encodeURIComponent(approval.runId)}/approvals/${encodeURIComponent(approval.approvalId)}`),
        token, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        schema: CanonicalChatApprovalSubmissionResponseSchema,
        errorMessage: "Could not submit approval. Try again.",
      });
      setSubmitted(true);
    } catch (_error) {
      setError("Could not submit approval. Try again.");
    } finally {
      try { await onSettled(); } catch (_error) { setError("Could not refresh chat. Try again."); }
      inFlight.current = false;
      setSubmitting(false);
    }
  }
  const tool = supervisedToolApproval(approval);
  if (tool) return <SupervisedToolCard tool={tool} submitting={submitting} submitted={submitted} error={error} permissionMode={permissionMode} onPermissionMode={onPermissionMode} onTryAgain={onTryAgain} onDecision={(decision) => void submit(decision)} />;
  return <View style={styles.card}>
    <Text style={styles.text}>{approval.title}</Text>
    <Text style={styles.text}>{approval.description}</Text>
    {approval.pending && !submitted ? <View style={styles.actions}>
      {approval.allowedDecisions.map(decision => <Pressable
        key={decision} accessibilityRole="button" disabled={submitting}
        accessibilityState={{ disabled: submitting }} style={styles.button}
        onPress={() => void submit(decision)}>
        <Text style={styles.text}>{decision === "approve_for_session" ? "Approve for session" : decision.charAt(0).toUpperCase() + decision.slice(1)}</Text>
      </Pressable>)}
    </View> : <Text style={styles.text}>{approval.pending ? "Decision submitted. Waiting for confirmation." : canonicalChatApprovalOutcome(approval.decision)}</Text>}
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
  </View>;
}

type PermissionModeChoice = "supervised" | "full_access";
type SettledSupervisedTool = Extract<SupervisedToolApproval, { kind: "allowed" | "declined" | "cancelled" }>;
type OpenSupervisedTool = Exclude<SupervisedToolApproval, SettledSupervisedTool>;

function SupervisedToolCard({
  tool, submitting, submitted, error, permissionMode, onPermissionMode, onTryAgain, onDecision,
}: {
  tool: SupervisedToolApproval;
  submitting: boolean;
  submitted: boolean;
  error: string | null;
  permissionMode?: string;
  onPermissionMode?: (mode: PermissionModeChoice) => void;
  onTryAgain?: () => void;
  onDecision: (decision: CanonicalChatApprovalDecision) => void;
}) {
  if (tool.kind === "allowed" || tool.kind === "declined" || tool.kind === "cancelled") {
    return <SupervisedToolSettled tool={tool} submitting={submitting} submitted={submitted} error={error} onDecision={onDecision} />;
  }
  return <SupervisedToolOpen tool={tool} submitting={submitting} submitted={submitted} error={error} permissionMode={permissionMode} onPermissionMode={onPermissionMode} onTryAgain={onTryAgain} onDecision={onDecision} />;
}

function SupervisedToolSettled({ tool, submitting, submitted, error, onDecision }: {
  tool: SettledSupervisedTool;
  submitting: boolean;
  submitted: boolean;
  error: string | null;
  onDecision: (decision: CanonicalChatApprovalDecision) => void;
}) {
  const canUndo = tool.kind === "allowed" && tool.undo && !submitted;
  return <View style={styles.compact}>
    <Text style={styles.muted}>{tool.line}</Text>
    {canUndo ? <Pressable accessibilityRole="button" disabled={submitting} onPress={() => onDecision("decline")}><Text style={styles.text}>Undo</Text></Pressable> : null}
    {submitted ? <Text style={styles.muted}>Decision submitted. Waiting for confirmation.</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
  </View>;
}

function SupervisedToolOpen({
  tool, submitting, submitted, error, permissionMode, onPermissionMode, onTryAgain, onDecision,
}: {
  tool: OpenSupervisedTool;
  submitting: boolean;
  submitted: boolean;
  error: string | null;
  permissionMode?: string;
  onPermissionMode?: (mode: PermissionModeChoice) => void;
  onTryAgain?: () => void;
  onDecision: (decision: CanonicalChatApprovalDecision) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const expired = tool.kind === "expired";
  const details = tool.kind === "waiting" ? tool.details : undefined;
  return <View style={[styles.card, expired ? styles.settled : styles.waiting]}>
    <Text style={styles.muted}>{expired ? "Request expired" : "Needs your approval"}</Text>
    <Text style={styles.title}>{tool.title}</Text>
    <Text style={styles.summary}>{tool.summary}</Text>
    {details ? <Pressable accessibilityRole="button" onPress={() => setDetailsOpen(open => !open)}><Text style={styles.muted}>See details</Text></Pressable> : null}
    {detailsOpen && details ? <Text style={styles.text}>{details}</Text> : null}
    {tool.kind === "waiting"
      ? <SupervisedToolActions tool={tool} submitting={submitting} submitted={submitted} onDecision={onDecision} onToggleMenu={onPermissionMode ? () => setMenuOpen(open => !open) : undefined} />
      : onTryAgain ? <Pressable accessibilityRole="button" onPress={onTryAgain}><Text style={styles.text}>Try again</Text></Pressable> : null}
    {menuOpen && onPermissionMode ? <PermissionModeMenu permissionMode={permissionMode} onSelect={(mode) => { setMenuOpen(false); onPermissionMode(mode); }} /> : null}
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
  </View>;
}

function SupervisedToolActions({ tool, submitting, submitted, onDecision, onToggleMenu }: {
  tool: Extract<SupervisedToolApproval, { kind: "waiting" }>;
  submitting: boolean;
  submitted: boolean;
  onDecision: (decision: CanonicalChatApprovalDecision) => void;
  onToggleMenu?: () => void;
}) {
  if (submitted) return <Text style={styles.muted}>Decision submitted. Waiting for confirmation.</Text>;
  return <View style={styles.actions}>
    {tool.allowOnce ? <Pressable accessibilityRole="button" disabled={submitting} style={styles.primary} onPress={() => onDecision("approve")}><Text style={styles.primaryText}>Allow once</Text></Pressable> : null}
    {tool.allowInChat ? <Pressable accessibilityRole="button" disabled={submitting} style={styles.button} onPress={() => onDecision("approve_for_session")}><Text style={styles.text}>Allow in this chat</Text></Pressable> : null}
    {tool.decline ? <Pressable accessibilityRole="button" disabled={submitting} onPress={() => onDecision("decline")}><Text style={styles.text}>Not now</Text></Pressable> : null}
    {onToggleMenu ? <Pressable accessibilityRole="button" onPress={onToggleMenu}><Text style={styles.muted}>Always allow → Full access</Text></Pressable> : null}
  </View>;
}

function PermissionModeMenu({ permissionMode, onSelect }: { permissionMode?: string; onSelect: (mode: PermissionModeChoice) => void }) {
  const fullAccess = permissionMode === "full_access";
  return <View accessibilityRole="menu">
    <Pressable accessibilityRole="menuitem" onPress={() => onSelect("supervised")}><Text style={styles.text}>Supervised{fullAccess ? "" : " · current"}</Text><Text style={styles.muted}>Asks before using tools like web search.</Text></Pressable>
    <Pressable accessibilityRole="menuitem" onPress={() => onSelect("full_access")}><Text style={styles.text}>Full access{fullAccess ? " · current" : ""}</Text><Text style={styles.muted}>Uses tools without asking. Switch back anytime.</Text></Pressable>
  </View>;
}

const styles = StyleSheet.create(theme => ({
  card: { padding: 16, gap: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12 },
  waiting: { borderColor: palette.gold[400], backgroundColor: theme.colors.card },
  settled: { backgroundColor: theme.colors.card },
  compact: { flexDirection: "row", alignItems: "center", gap: 8 },
  text: { color: theme.colors.foreground },
  title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "500" },
  muted: { color: theme.colors.secondaryForeground, fontSize: 12 },
  summary: { color: theme.colors.foreground, fontSize: 13, backgroundColor: theme.colors.secondary, borderRadius: 8, padding: 10 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  button: { padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 },
  primary: { paddingHorizontal: 10, height: 28, justifyContent: "center", borderRadius: 10, backgroundColor: theme.colors.foreground },
  primaryText: { color: theme.colors.background, fontSize: 13, fontWeight: "500" },
}));

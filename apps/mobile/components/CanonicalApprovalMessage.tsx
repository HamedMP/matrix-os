import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAuth } from "@clerk/clerk-expo";
import {
  CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalSubmitChatApprovalRequestSchema,
  type CanonicalChatApprovalDecision,
  type CanonicalChatApprovalView,
} from "@matrix-os/contracts";
import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

export function CanonicalApprovalMessage({ approval, chatId, gatewayUrl, onSettled }: {
  approval: CanonicalChatApprovalView;
  chatId: string;
  gatewayUrl: string;
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
    if (inFlight.current || submitted || !approval.pending || !approval.allowedDecisions.includes(decision)) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      const clientRequestId = requestIds.current[decision] ??= canonicalChatRequestId();
      const body = CanonicalSubmitChatApprovalRequestSchema.parse({ decision, clientRequestId });
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
    </View> : <Text style={styles.text}>Resolved</Text>}
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create(theme => ({
  card: { padding: 12, gap: 8, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12 },
  text: { color: theme.colors.foreground },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 },
}));

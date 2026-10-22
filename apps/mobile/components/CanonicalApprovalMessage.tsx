import { z } from "zod/v4";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAuth } from "@clerk/clerk-expo";
import {
  CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalSubmitChatApprovalRequestSchema,
  canonicalChatApprovalOutcome,
  createBrowserGrantUndoTracker, reconcileBrowserGrantObservation, browserPermissionChoices, browserPermissionRequest, browserPermissionErrorKind, browserPermissionOutcome, browserCanonicalDecision, BrowserGrantViewSchema,
  type BrowserPermissionChoice, type BrowserGrantView,
  type CanonicalChatApprovalDecision,
  type CanonicalChatApprovalView,
} from "@matrix-os/contracts";
import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

export function CanonicalApprovalMessage({ approval, chatId, gatewayUrl, onSettled, grantRefreshKey }: {
  approval: CanonicalChatApprovalView;
  chatId: string;
  gatewayUrl: string;
  onSettled: () => Promise<unknown> | void;
  /** Refresh all mounted cards even when refetched Chat records are unchanged. */
  grantRefreshKey?: object;
}) {
  const { getToken } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo] = useState(createBrowserGrantUndoTracker);
  const [clock, setClock] = useState(Date.now);
  const [grant, setGrant] = useState<BrowserGrantView | null>(null);
  const [grantRefresh, setGrantRefresh] = useState(0);
  const scope = useRef<object>({});
  const grantRead = useRef<object>({});
  const inFlight = useRef(false);
  // At most seven decision keys; preserve an ambiguous request's id on retry.
  const requestIds = useRef<Partial<Record<CanonicalChatApprovalDecision | BrowserPermissionChoice, string>>>({});
  useEffect(() => {
    const current = {}; scope.current = current; inFlight.current = false;
    setGrant(null); setSubmitting(false); setSubmitted(false); setError(null); requestIds.current = {};
    return () => { if (scope.current === current) scope.current = {}; };
  }, [chatId, gatewayUrl, approval.approvalId, approval.runId, getToken]);
  useEffect(() => {
    const current = scope.current; const read = {}; grantRead.current = read; let cancelled = false;
    if (approval.browserApproval) void (async () => {
      const token = await getToken(); if (!token) throw new Error("Not signed in");
      const result = await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(chatId)}/browser-grants`), token,
        schema: z.strictObject({ grant: BrowserGrantViewSchema.nullable() }), errorMessage: "Could not check browser access." });
      if (!cancelled && scope.current === current && grantRead.current === read) setGrant(prior => reconcileBrowserGrantObservation(prior, result.grant, chatId));
    })().catch((error: unknown) => { console.warn("[browser-permission] Grant read failed", browserPermissionErrorKind(error)); if (!cancelled && scope.current === current && grantRead.current === read) setError("Could not check browser access. Refresh this Chat."); });
    return () => { cancelled = true; };
  }, [chatId, gatewayUrl, approval.approvalId, approval.runId, approval.browserGrant, approval.browserApproval, getToken, grantRefresh, grantRefreshKey]);
  useEffect(() => {
    if (!approval.pending || !approval.browserApproval) return;
    const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer);
  }, [approval.pending, approval.browserApproval?.expiresAt]);
  const pending = approval.pending && (!approval.browserApproval || (!approval.browserApproval.resolution && Date.parse(approval.browserApproval.expiresAt) > clock));
  async function submit(decision: CanonicalChatApprovalDecision, browserChoice?: BrowserPermissionChoice) {
    if (inFlight.current || submitted || !approval.pending || !approval.allowedDecisions.includes(decision)) return;
    const current = scope.current;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      const clientRequestId = requestIds.current[browserChoice ?? decision] ??= canonicalChatRequestId();
      const body = browserChoice ? browserPermissionRequest(approval, browserChoice, clientRequestId) : CanonicalSubmitChatApprovalRequestSchema.parse({ decision, clientRequestId,
        ...(approval.actionDigest !== undefined ? { actionDigest: approval.actionDigest } : {}) });
      await fetchAuthenticatedJson({
        url: buildGatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(chatId)}/runs/${encodeURIComponent(approval.runId)}/approvals/${encodeURIComponent(approval.approvalId)}`),
        token, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        schema: CanonicalChatApprovalSubmissionResponseSchema,
        errorMessage: "Could not submit approval. Try again.",
      });
      if (scope.current === current) { grantRead.current = {}; setSubmitted(true); }
    } catch (_error) {
      if (scope.current === current) setError("Could not submit approval. Try again.");
    } finally {
      if (scope.current === current) {
        if (browserChoice) setGrantRefresh(value => value + 1);
        try { await onSettled(); } catch (_error) { if (scope.current === current) setError("Could not refresh chat. Try again."); }
        if (scope.current === current) { inFlight.current = false; setSubmitting(false); }
      }
    }
  }
  return <View style={styles.card}>
    <Text style={styles.text}>{approval.title}</Text>
    <Text style={styles.text}>{approval.description}</Text>
    {pending && !submitted ? <View style={styles.actions}>
      {(approval.browserApproval ? browserPermissionChoices.map(choice => ({ ...choice, canonical: browserCanonicalDecision(choice.decision) })) : approval.allowedDecisions.map(decision => ({ decision, canonical: decision, label: decision === "approve_for_session" ? "Approve for session" : decision.charAt(0).toUpperCase() + decision.slice(1) }))).map(choice => <Pressable
        key={choice.decision} accessibilityRole="button" disabled={submitting}
        accessibilityState={{ disabled: submitting }} style={styles.button}
        onPress={() => void submit(choice.canonical, approval.browserApproval ? choice.decision as BrowserPermissionChoice : undefined)}>
        <Text style={styles.text}>{choice.label}</Text>
      </Pressable>)}
    </View> : <Text style={styles.text}>{approval.browserApproval ? browserPermissionOutcome(approval, clock, submitted) : approval.pending ? "Decision submitted. Waiting for confirmation." : canonicalChatApprovalOutcome(approval.decision)}</Text>}
    {grant?.state === "active" && !approval.browserGrant ? <Text style={styles.text}>Browser access is saved for this Chat</Text> : null}
    {grant?.state === "active" ? <Pressable accessibilityRole="button" disabled={submitting} style={styles.button} onPress={() => void (async () => {
      if (inFlight.current) return; const current = scope.current; inFlight.current = true; setSubmitting(true); setError(null);
      try {
        const token = await getToken(); if (!token) throw new Error("Not signed in");
        const body = undo.request(grant, canonicalChatRequestId);
        const result = await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(chatId)}/browser-grants/${encodeURIComponent(grant.id)}`),
          token, method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), schema: z.strictObject({ grant: BrowserGrantViewSchema }), errorMessage: "Could not undo browser access." });
        if (result.grant.state !== "revoked") throw new Error("Access not removed");
        if (scope.current === current) {
          grantRead.current = {};
          setGrant(prior => reconcileBrowserGrantObservation(prior, result.grant, chatId));
          try { await onSettled(); }
          catch (error: unknown) { console.warn("[browser-permission] Grant refresh failed", browserPermissionErrorKind(error)); if (scope.current === current) setError("Could not refresh Chat. Browser access was removed."); }
        }
      } catch (error: unknown) { console.warn("[browser-permission] Undo failed", browserPermissionErrorKind(error)); if (scope.current === current) setError("Could not undo browser access. Try again."); }
      finally { if (scope.current === current) { inFlight.current = false; setSubmitting(false); } }
    })()}><Text style={styles.text}>Undo</Text></Pressable> : null}
    {grant?.state === "revoked" ? <Text style={styles.text}>Remembered browser access removed</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create(theme => ({
  card: { padding: 12, gap: 8, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12 },
  text: { color: theme.colors.foreground },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 },
}));

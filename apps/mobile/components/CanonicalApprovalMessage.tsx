import { RoutineActionIdSchema } from "@matrix-os/contracts";
import { NativeRoutineActionConfirmation } from "./RoutineActionConfirmation";
import { z } from "zod/v4";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { Button } from "@/components/ui";
import { StyleSheet } from "react-native-unistyles";
import { useAuth } from "@clerk/clerk-expo";
import {
  CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalSubmitChatApprovalRequestSchema,
  canonicalChatApprovalOutcome,
  supervisedToolApproval,
  createBrowserGrantUndoTracker, reconcileBrowserGrantObservation, browserPermissionChoices, browserPermissionRequest, browserPermissionErrorKind, browserPermissionOutcome, browserCanonicalDecision, BrowserGrantViewSchema,
  type BrowserPermissionChoice, type BrowserGrantView,
  type CanonicalChatApprovalDecision,
  type CanonicalChatApprovalView,
} from "@matrix-os/contracts";
import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";
import { ApprovalRequestCard, type ApprovalAction } from "./chat/ApprovalRequestCard";

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
  // The decision being sent, so its own button shows the spinner.
  const [sending, setSending] = useState<CanonicalChatApprovalDecision | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo] = useState(createBrowserGrantUndoTracker);
  const [clock, setClock] = useState(Date.now);
  const [grant, setGrant] = useState<BrowserGrantView | null>(null);
  const [grantRefresh, setGrantRefresh] = useState(0);
  const scope = useRef<object>({});
  const grantRead = useRef<object>({});
  const inFlight = useRef(false);
  const getScopedToken = useCallback(async (current: object) => {
    const token = await getToken();
    return scope.current === current ? token : null;
  }, [getToken]);
  // At most seven decision keys; preserve an ambiguous request's id on retry.
  const requestIds = useRef<Partial<Record<CanonicalChatApprovalDecision | BrowserPermissionChoice, string>>>({});
  useEffect(() => {
    const current = {}; scope.current = current; inFlight.current = false;
    setGrant(null); setSubmitting(false); setSending(null); setSubmitted(false); setError(null); requestIds.current = {};
    return () => { if (scope.current === current) scope.current = {}; };
  }, [chatId, gatewayUrl, approval.approvalId, approval.runId, getToken]);
  useEffect(() => {
    const current = scope.current; const read = {}; grantRead.current = read; let cancelled = false;
    if (approval.browserApproval) void (async () => {
      const result = await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(chatId)}/browser-grants`),
        token: () => getScopedToken(current),
        schema: z.strictObject({ grant: BrowserGrantViewSchema.nullable() }), errorMessage: "Could not check browser access." });
      if (!cancelled && scope.current === current && grantRead.current === read) setGrant(prior => reconcileBrowserGrantObservation(prior, result.grant, chatId));
    })().catch((error: unknown) => { console.warn("[browser-permission] Grant read failed", browserPermissionErrorKind(error)); if (!cancelled && scope.current === current && grantRead.current === read) setError("Could not check browser access. Refresh this Chat."); });
    return () => { cancelled = true; };
  }, [chatId, gatewayUrl, approval.approvalId, approval.runId, approval.browserGrant, approval.browserApproval, getScopedToken, grantRefresh, grantRefreshKey]);
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
    setSending(decision);
    setError(null);
    try {
      const clientRequestId = requestIds.current[browserChoice ?? decision] ??= canonicalChatRequestId();
      const body = browserChoice ? browserPermissionRequest(approval, browserChoice, clientRequestId) : CanonicalSubmitChatApprovalRequestSchema.parse({ decision, clientRequestId,
        ...(approval.actionDigest !== undefined ? { actionDigest: approval.actionDigest } : {}) });
      await fetchAuthenticatedJson({
        url: buildGatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(chatId)}/runs/${encodeURIComponent(approval.runId)}/approvals/${encodeURIComponent(approval.approvalId)}`),
        token: () => getScopedToken(current), method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
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
        if (scope.current === current) { inFlight.current = false; setSubmitting(false); setSending(null); }
      }
    }
  }
  if (approval.pending && RoutineActionIdSchema.safeParse(approval.approvalId).success) return <NativeRoutineActionConfirmation challengeId={approval.approvalId} gatewayUrl={gatewayUrl}/>;
  const tool = approval.browserApproval ? null : supervisedToolApproval(approval);
  const labels = { approve: "Allow once", approve_for_session: "Allow for this session", decline: "Not now", cancel: "Cancel request" };
  const choices = approval.browserApproval
    ? browserPermissionChoices.map(choice => ({ key: choice.decision, label: choice.label,
      canonical: browserCanonicalDecision(choice.decision), browserChoice: choice.decision }))
    : approval.allowedDecisions.map(decision => ({ key: decision, label: labels[decision], canonical: decision, browserChoice: undefined }));
  const actions: ApprovalAction[] = choices.filter(choice => approval.allowedDecisions.includes(choice.canonical)).map(choice => ({
    key: choice.key, label: choice.label, primary: choice.canonical === "approve",
    loading: submitting && sending === choice.canonical, disabled: submitting,
    onPress: () => void submit(choice.canonical, choice.browserChoice),
  }));
  const expired = approval.reason === "expired" || tool?.kind === "expired" || (approval.pending && !pending);
  const structured = /^(?:\{|\[)/.test(approval.description.trim());
  const summary = tool?.kind === "waiting" || tool?.kind === "expired" ? tool.summary
    : pending && !structured ? approval.description : undefined;
  const details = tool?.kind === "waiting" ? tool.details : structured ? approval.description : undefined;
  const outcome = !pending && !expired ? {
    line: approval.browserApproval ? browserPermissionOutcome(approval, clock, submitted)
      : tool && tool.kind !== "waiting" ? tool.line : canonicalChatApprovalOutcome(approval.decision),
    allowed: approval.decision === "approve" || approval.decision === "approve_for_session",
  } : undefined;
  return <ApprovalRequestCard title={tool?.kind === "waiting" || tool?.kind === "expired" ? tool.title : approval.title}
    summary={summary} details={details} waiting={pending} label={expired ? "Request expired" : undefined}
    outcome={outcome} actions={actions} submitted={pending && submitted} error={error}>
    {approval.browserApproval ? <>
    {grant?.state === "active" && !approval.browserGrant ? <Text style={styles.text}>Browser access is saved for this Chat</Text> : null}
    {grant?.state === "active" ? <Button label="Undo" variant="outline" fullWidth disabled={submitting} onPress={() => void (async () => {
      if (inFlight.current) return; const current = scope.current; inFlight.current = true; setSubmitting(true); setError(null);
      try {
        const body = undo.request(grant, canonicalChatRequestId);
        const result = await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(chatId)}/browser-grants/${encodeURIComponent(grant.id)}`),
          token: () => getScopedToken(current), method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), schema: z.strictObject({ grant: BrowserGrantViewSchema }), errorMessage: "Could not undo browser access." });
        if (result.grant.state !== "revoked") throw new Error("Access not removed");
        if (scope.current === current) {
          grantRead.current = {};
          setGrant(prior => reconcileBrowserGrantObservation(prior, result.grant, chatId));
          try { await onSettled(); }
          catch (error: unknown) { console.warn("[browser-permission] Grant refresh failed", browserPermissionErrorKind(error)); if (scope.current === current) setError("Could not refresh Chat. Browser access was removed."); }
        }
      } catch (error: unknown) { console.warn("[browser-permission] Undo failed", browserPermissionErrorKind(error)); if (scope.current === current) setError("Could not undo browser access. Try again."); }
      finally { if (scope.current === current) { inFlight.current = false; setSubmitting(false); } }
    })()} /> : null}
    {grant?.state === "revoked" ? <Text style={styles.text}>Remembered browser access removed</Text> : null}
    </> : null}
  </ApprovalRequestCard>;
}

const styles = StyleSheet.create(theme => ({
  text: { color: theme.colors.foreground },
}));

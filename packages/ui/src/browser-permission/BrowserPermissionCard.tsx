import { useBrowserPermissionReview, useBrowserPermissionGrants } from "./BrowserPermissionReview.js";
import React, { useEffect, useRef, useState } from "react";
import { createBrowserGrantUndoTracker, reconcileBrowserGrantObservation, browserPermissionChoices, browserPermissionOutcome, browserPermissionRequest, browserPermissionErrorKind,
  type BrowserPermissionChoice, type CanonicalChatApprovalView, type BrowserGrantView } from "@matrix-os/contracts";
import { chatAgentButtonClass, chatAgentPrimaryButtonClass, chatAgentMutedStyle, chatAgentSurfaceStyle } from "../chat-agents/theme.js";
import type { BrowserPermissionClient } from "./client.js";

export function BrowserPermissionCard({ approval, chatId, onDecision, client, submitting = false, onOpenPermissionMode }: {
  chatId?: string;
  approval: CanonicalChatApprovalView; onDecision?: (choice: BrowserPermissionChoice) => Promise<void>;
  client?: BrowserPermissionClient; submitting?: boolean; onOpenPermissionMode?: () => void;
}) {
  const element = useRef<HTMLElement>(null);
  const registerReview = useBrowserPermissionReview();
  const sharedGrants = useBrowserPermissionGrants();
  const [undo] = useState(createBrowserGrantUndoTracker);
  const [clock, setClock] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<BrowserGrantView | null>(null);
  const [grantRefresh, setGrantRefresh] = useState(0);
  const scope = useRef<object>({});
  const grantRead = useRef<object>({});
  const activeAction = useRef(false);
  const grantChatId = chatId ?? approval.browserGrant?.chatId;
  const identity = `${grantChatId ?? ""}:${approval.runId}:${approval.approvalId}`;
  useEffect(() => {
    const current = {}; scope.current = current; activeAction.current = false; setBusy(false); setSubmitted(false); setError(null); setGrant(null);
    return () => { if (scope.current === current) scope.current = {}; };
  }, [identity, client]);
  useEffect(() => {
    const current = scope.current; const read = {}; grantRead.current = read; let cancelled = false;
    if (client && grantChatId) void client.getGrant(grantChatId).then(fresh => {
      if (!cancelled && scope.current === current && grantRead.current === read) setGrant(prior => reconcileBrowserGrantObservation(prior, fresh, grantChatId));
    }).catch((error: unknown) => { console.warn("[browser-permission] Grant read failed", browserPermissionErrorKind(error)); if (!cancelled && scope.current === current && grantRead.current === read) setError("Browser access could not be checked. Refresh this Chat."); });
    return () => { cancelled = true; };
  }, [identity, approval.browserGrant, client, grantChatId, grantRefresh, sharedGrants?.grantsRevision]);
  useEffect(() => {
    if (!approval.pending || !approval.browserApproval || approval.browserApproval.resolution) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [identity, approval.pending, approval.browserApproval?.expiresAt, approval.browserApproval?.resolution]);
  const waiting = !submitted && approval.pending && !approval.browserApproval?.resolution && Date.parse(approval.browserApproval?.expiresAt ?? "") > clock;
  useEffect(() => {
    if (waiting && element.current && registerReview) return registerReview({ node: element.current, expiresAt: Date.parse(approval.browserApproval!.expiresAt) });
  }, [waiting, identity, registerReview, approval.browserApproval?.expiresAt]);
  async function perform(work: () => Promise<void>) {
    if (activeAction.current || submitting) return;
    const current = scope.current; activeAction.current = true; setBusy(true); setError(null);
    try { await work(); }
    catch (error: unknown) { console.warn("[browser-permission] Decision failed", browserPermissionErrorKind(error)); if (scope.current === current) setError("The decision could not be saved. Refresh and try again."); }
    finally { if (scope.current === current) { activeAction.current = false; setBusy(false); } }
  }
  return <section ref={element} tabIndex={-1} aria-label="Matrix Browser permission" className="w-full rounded-xl p-4 text-sm" style={{ ...chatAgentSurfaceStyle,
    ...(waiting ? { borderColor: "var(--warning, var(--matrix-warning, var(--border-default, var(--border))))" } : {}) }}>
    {waiting ? <>
      <div className="mb-3 flex items-center justify-between gap-3 text-xs" style={chatAgentMutedStyle}>
        <span className="flex items-center gap-2"><span aria-hidden className="size-2 rounded-full" style={{ background: "var(--warning, var(--matrix-warning, currentColor))" }}/>Needs your approval</span>
        <details><summary className="cursor-pointer">See details</summary><p className="mt-2 max-w-sm">This action uses the Chrome profile on your Matrix computer, including websites you are signed into. Allowing this Chat covers future browser actions in this Chat until you undo it.</p></details>
      </div>
      <p className="font-medium">Use Matrix Browser</p>
      <p className="my-3 rounded-lg px-3 py-2 text-[13px] leading-5" style={{ ...chatAgentMutedStyle, background: "var(--bg-muted, var(--matrix-secondary, var(--secondary)))" }}>{approval.description}</p>
      <div className="flex flex-wrap items-center gap-2">{browserPermissionChoices.map(choice => <button key={choice.decision} type="button"
        className={choice.decision === "allow_once" ? chatAgentPrimaryButtonClass : chatAgentButtonClass}
        disabled={busy || submitting || !onDecision} onClick={() => void perform(async () => {
          browserPermissionRequest(approval, choice.decision, "req_ui_validation");
          const current = scope.current;
          try { await onDecision!(choice.decision); if (scope.current === current) { grantRead.current = {}; setSubmitted(true); } }
          finally { if (scope.current === current) { if (sharedGrants) sharedGrants.grantsChanged(); else setGrantRefresh(value => value + 1); } }
        })}>{choice.label}</button>)}
        {onOpenPermissionMode ? <button type="button" className="ml-auto text-xs underline" onClick={onOpenPermissionMode}>Always allow → Full access</button> : null}
      </div>
    </> : <div className="flex flex-wrap items-center gap-3">
      <p style={chatAgentMutedStyle}>{browserPermissionOutcome(approval, clock, submitted)}</p>
    </div>}
    <div className="flex flex-wrap items-center gap-3">
      {grant?.state === "active" && !approval.browserGrant ? <span style={chatAgentMutedStyle}>Browser access is saved for this Chat</span> : null}
      {grant?.state === "active" && client ? <button type="button" className={chatAgentButtonClass} disabled={busy} onClick={() => void perform(async () => {
        const current = scope.current;
        const attempt = undo.request(grant, () => `req_${crypto.randomUUID().replaceAll("-", "")}`);
        const revoked = await client.revokeGrant(grant, attempt.clientRequestId);
        if (revoked.state !== "revoked") throw new Error("Access not removed");
        if (scope.current === current) { grantRead.current = {}; setGrant(prior => reconcileBrowserGrantObservation(prior, revoked, grantChatId!)); sharedGrants?.grantsChanged(); }
      })}>Undo</button> : null}
      {grant?.state === "revoked" ? <span style={chatAgentMutedStyle}>Remembered browser access removed</span> : null}
    </div>
    {error ? <p role="alert" className="mt-2 text-xs">{error}</p> : null}
  </section>;
}

"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@matrix-os/ui";
import { Textarea } from "../ui/textarea";
import type { SiteEmailInvitationInputResult, SiteEmailInvitationPage, SiteEmailInvitationSummary, SiteRecord } from "@matrix-os/contracts";
import { siteActionError, type SiteClient } from "../../lib/site-client";
import { formatSiteDate } from "./format-site-date";
import type { useAppSite } from "./use-app-site";

type AppSiteState = ReturnType<typeof useAppSite>;
type Result = { email: string; result: SiteEmailInvitationInputResult };

const outcomeLabel: Record<SiteEmailInvitationInputResult["outcome"], string> = {
  queued: "queued", existing: "existing invitation", invalid: "invalid address",
  duplicate_in_batch: "listed twice", policy_rejected: "could not invite",
};
const canResend = (invitation: SiteEmailInvitationSummary) => invitation.state === "expired"
  || invitation.state === "revoked" || (invitation.state === "pending"
    && (["failed", "ambiguous", "suppressed"].includes(invitation.deliveryState)
      || Date.parse(invitation.expiresAt) <= Date.now()));

/** Lives inside PR #3200's Share section; server capability and access mode gate every action. */
export function SiteEmailInvitations({ appSlug, client, site, state, disabled }: {
  appSlug: string; client: SiteClient; site: SiteRecord | null; state: AppSiteState; disabled: boolean;
}) {
  const [addresses, setAddresses] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [page, setPage] = useState<SiteEmailInvitationPage | null>(null);
  const [hasLoadedMore, setHasLoadedMore] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const mutationVersion = useRef(0);
  const pagingVersion = useRef(0);
  const capability = site?.capabilities?.privateEmailInvitations === true;
  const ready = capability && site?.status === "published" && site.accessMode === "private_email";

  useEffect(() => {
    if (!ready) { setPage(null); return; }
    const controller = new AbortController();
    const version = mutationVersion.current;
    void client.emailInvitations(appSlug, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      if (mutationVersion.current !== version) { setReload(value => value + 1); return; }
      setPage(next); setHasLoadedMore(false); setResetting(false); setLoadError(null);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(siteActionError(error));
    });
    return () => controller.abort();
  }, [appSlug, client, ready, site?.id, site?.revision, state.conflict, reload]);

  function invite(event: FormEvent) {
    event.preventDefault();
    if (!ready || !site || disabled || state.conflict) return;
    const emails = addresses.split(/[,;\n]/).map(value => value.trim()).filter(Boolean);
    if (!emails.length || emails.length > 100 || addresses.length > 30 * 1024) {
      setInputError("Enter 1 to 100 email addresses."); return;
    }
    setInputError(null);
    void state.mutate(signal => client.createEmailInvitations(appSlug,
      { baseRevision: site.revision, emailAddresses: emails }, signal), response => {
      mutationVersion.current += 1;
      setResults(response.results.map(result => ({ email: emails[result.inputIndex]!, result })));
      setAddresses("");
      state.syncSite({ ...site, revision: response.siteRevision });
      setReload(value => value + 1);
    }, "Invitation request saved.");
  }

  function change(invitation: SiteEmailInvitationSummary, action: "resend" | "revoke") {
    if (!ready || !site) return;
    const value = { baseRevision: site.revision, invitationRevision: invitation.revision };
    void state.mutate(signal => action === "resend"
      ? client.resendEmailInvitation(appSlug, invitation.id, value, signal)
      : client.revokeEmailInvitation(appSlug, invitation.id, value, signal), response => {
      mutationVersion.current += 1;
      state.syncSite({ ...site, revision: response.siteRevision });
      setPage(current => current ? { ...current, siteRevision: response.siteRevision,
        invitations: current.invitations.map(item => item.id === response.invitation.id ? response.invitation : item) } : current);
      setReload(value => value + 1);
    }, action === "resend" ? "Invitation queued again." : "Invitation revoked.");
  }

  function loadMore() {
    if (!ready || resetting || !page?.nextCursor) return;
    const version = mutationVersion.current;
    const pagingRequestVersion = pagingVersion.current;
    void state.action(signal => client.emailInvitations(appSlug, signal, page.nextCursor), next => {
      if (pagingVersion.current !== pagingRequestVersion) return;
      if (mutationVersion.current !== version) { setReload(value => value + 1); return; }
      setPage(current => current ? { ...next,
        invitations: [...current.invitations, ...next.invitations.filter(item =>
          !current.invitations.some(existing => existing.id === item.id))].slice(-100) } : next);
      setHasLoadedMore(true);
    });
  }

  function showNewest() {
    if (!ready || resetting) return;
    pagingVersion.current += 1;
    setResetting(true);
    setReload(value => value + 1);
  }

  const explanation = !capability ? "Email invitations are not available yet."
    : ready ? "Recipients use a verified email and open this app at its Matrix.page URL."
      : "Choose Private — invited email under publishing settings to invite people.";
  return <div className="space-y-2">
    <p className="text-xs leading-4" style={{ color: "var(--muted-foreground, var(--text-secondary, GrayText))" }}>{explanation}</p>
    <form onSubmit={invite} className="ph-no-capture grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2" data-ph-mask="true">
      <Textarea aria-label="Invite by email" disabled={!ready || disabled || state.conflict}
        value={addresses} maxLength={30 * 1024} rows={2} placeholder="Invite by email, one per line or separated by commas"
        onChange={event => setAddresses(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") setAddresses(""); }}
        className="min-w-0 resize-y text-sm" />
      <Button type="submit" disabled={!ready || disabled || state.conflict || !addresses.trim()} size="sm">Invite</Button>
    </form>
    {inputError ? <p role="alert" className="text-xs">{inputError}</p> : null}
    {results.length ? <ul aria-label="Invitation results" aria-live="polite" className="ph-no-capture space-y-1 text-xs" data-ph-mask="true">
      {results.map(result => <li key={result.result.inputIndex}>{result.email} — {outcomeLabel[result.result.outcome]}
        {result.result.outcome === "existing" ? ` (${result.result.invitation.state})` : null}</li>)}
    </ul> : null}
    {ready && loadError ? <div className="space-y-1"><p role="alert" className="text-xs">{loadError}</p>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => { setLoadError(null); setReload(value => value + 1); }}>Retry invitation list</Button></div> : null}
    {ready && page?.invitations.length ? <ul aria-label="Email invitations" className="ph-no-capture space-y-2 border-t pt-2 text-xs" data-ph-mask="true">
      {page.invitations.map(invitation => <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2">
        <span className="min-w-0 break-all"><strong>{invitation.emailAddress}</strong> · {invitation.state} · {invitation.deliveryState}
          {invitation.state === "pending" ? ` · Expires ${formatSiteDate(invitation.expiresAt)}` : null}</span>
        <span className="flex flex-wrap gap-2">
          {canResend(invitation) ? <Button size="sm" variant="secondary" disabled={disabled || state.conflict} onClick={() => change(invitation, "resend")}>Resend</Button> : null}
          {invitation.state === "pending" || invitation.state === "accepted" ? <Button size="sm" variant="destructive" disabled={disabled || state.conflict} onClick={() => change(invitation, "revoke")}>Revoke invitation</Button> : null}
        </span>
      </li>)}
    </ul> : ready && page ? <p className="text-xs">No email invitations yet.</p> : null}
    {ready && page?.nextCursor ? <Button size="sm" variant="secondary" disabled={disabled || state.conflict || resetting} onClick={loadMore}>Load more invitations</Button> : null}
    {ready && hasLoadedMore ? <Button size="sm" variant="secondary" disabled={disabled || state.conflict || resetting}
      onClick={showNewest}>Show newest invitations</Button> : null}
  </div>;
}

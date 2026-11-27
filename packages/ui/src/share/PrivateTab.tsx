"use client";
import { useId } from "react";
import { Link2, RotateCw, X } from "lucide-react";
import { canResendEmailInvitation, type EmailInvitationSummary } from "./email-invitations";
import { isInviteEmail } from "./share-model";
import { InlineError, ShareBadge, ShareButton, ShareInput, Spinner } from "./share-controls";
import type { ShareController } from "./use-share-controller";
import { useCopy } from "./use-copy";

// Allowlist mode (spec 2691 amendment): no email is sent, so no row claims delivery.
const INVITE_STATUS: Record<EmailInvitationSummary["state"], string> = { pending: "Not opened yet", accepted: "Has access", expired: "Expired", revoked: "Removed" };

/**
 * Shown for the email allowlist, or for a legacy one-time-link site (spec 2693):
 * one-time links are retired, so that site gets one line and a way to stop
 * sharing. A live invite-only site keeps its list (read-only while the server
 * capability is off) and a way to stop sharing without going public. A
 * stop-only app (Matrix default app) keeps the list, Revoke and Stop sharing,
 * but offers no new invites or resends.
 */
export function PrivateTab({ share, ownerInitial, appUrl, draft, setDraft }: {
  share: ShareController; ownerInitial: string; appUrl: string | null; draft: string; setDraft: (value: string) => void;
}) {
  const emailPublished = share.pageMode === "private_email" && share.site?.status === "published";
  return <div className="flex flex-col gap-3">
    {share.pageMode === "private_link" ? <div className="flex items-center justify-between gap-2">
      <span className="text-[13px] text-[var(--share-muted-fg)]">Uses retired one-time links</span>
      <StopPrivateSharing share={share} />
    </div> : null}
    {share.emailInvitesAvailable || share.pageMode === "private_email" ? <InvitePeople share={share} ownerInitial={ownerInitial} appUrl={appUrl} draft={draft} setDraft={setDraft} /> : null}
    {emailPublished ? <div className="flex justify-end"><StopPrivateSharing share={share} /></div> : null}
    {share.error?.operation === "stop" ? <InlineError>{share.error.message}</InlineError> : null}
  </div>;
}

function StopPrivateSharing({ share }: { share: ShareController }) {
  return <ShareButton variant="link" disabled={share.operation !== null} onClick={() => void share.stopSharing()}>
    {share.operation === "stop" ? <Spinner /> : null}Stop sharing privately
  </ShareButton>;
}

function InvitePeople({ share, ownerInitial, appUrl, draft, setDraft }: { share: ShareController; ownerInitial: string; appUrl: string | null; draft: string; setDraft: (value: string) => void }) {
  const available = share.emailInvitesAvailable;
  const canInvite = share.allowNewSharing;
  const busy = share.operation !== null;
  const people = share.pageMode === "private_email" ? share.invitations : [];
  return <>
    {canInvite ? <AddPeople share={share} draft={draft} setDraft={setDraft} /> : null}
    {share.error?.operation === "invite" || share.error?.operation === "invite_change" ? <InlineError>{share.error.message}</InlineError> : null}
    {share.inviteOutcome ? <p role="status" className="m-0 text-xs text-[var(--share-muted-fg)]">{share.inviteOutcome === "queued" ? "Added. Copy the link and send it to them." : "This address is already on the list."}</p> : null}
    <ul aria-label="People with access" className="ph-no-capture m-0 flex list-none flex-col p-0" data-ph-mask="true">
      <li className="flex h-10 items-center gap-2.5">
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--share-primary)] text-xs font-semibold text-[var(--share-primary-fg)]">{ownerInitial}</span>
        <span className="min-w-0 flex-1 text-[13px] font-medium">You</span>
        <ShareBadge>Owner</ShareBadge>
      </li>
      {people.map((person) => <PersonRow key={person.id} person={person} share={share} canRenew={canInvite} disabled={busy || !available} />)}
    </ul>
    <InviteListFooter share={share} appUrl={appUrl} disabled={busy || !available} />
  </>;
}

/** A stop-only app (canRenew false) keeps Remove but offers no Renew. */
/** Only offered when the app may start new sharing (not a stop-only default app). */
function AddPeople({ share, draft, setDraft }: { share: ShareController; draft: string; setDraft: (value: string) => void }) {
  const inputId = useId();
  const available = share.emailInvitesAvailable;
  const valid = isInviteEmail(draft);
  const busy = share.operation !== null;
  const blocked = !available || share.loading || share.loadFailed;
  const submit = async () => {
    if (!available || !valid || busy) return;
    const done = await share.request({ to: "private_email", email: draft.trim() });
    // A pending mode-switch confirm keeps the draft until the owner decides.
    if (done) setDraft("");
  };
  return <>
    <div className="flex gap-2">
      <label htmlFor={inputId} className="sr-only">Email address</label>
      <ShareInput id={inputId} type="email" autoComplete="off" maxLength={254} className="ph-no-capture" data-ph-mask="true" placeholder="Add people by email" value={draft}
        disabled={blocked}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }} />
      <ShareButton variant="primary" disabled={blocked || !valid || busy} onClick={() => void submit()}>
        {share.operation === "invite" ? <Spinner /> : null}Add
      </ShareButton>
    </div>
    <p className="m-0 -mt-1 text-xs text-[var(--share-subtle-fg)]">{available ? "We don’t send email. Copy the link and send it yourself. Only these people can open it after signing in." : "Private sharing isn’t available right now."}</p>
  </>;
}

function PersonRow({ person, share, canRenew, disabled }: { person: EmailInvitationSummary; share: ShareController; canRenew: boolean; disabled: boolean }) {
  const removable = person.state === "pending" || person.state === "accepted";
  return <li className="flex min-h-10 items-center gap-2.5 py-1">
    <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--share-muted)] text-xs font-semibold">{person.emailAddress.charAt(0).toUpperCase()}</span>
    <span className="flex min-w-0 flex-1 flex-col gap-px">
      <span className="truncate text-[13px] font-medium">{person.emailAddress}</span>
      <span className="text-xs text-[var(--share-muted-fg)]">{INVITE_STATUS[person.state]}</span>
    </span>
    {canRenew && canResendEmailInvitation(person) ? <ShareButton variant="ghost" size="icon" aria-label={`Renew access for ${person.emailAddress}`} title="Renew" disabled={disabled} onClick={() => void share.resendInvite(person)}><RotateCw className="size-3.5" /></ShareButton> : null}
    {removable ? <ShareButton variant="ghost" size="icon" aria-label={`Remove access for ${person.emailAddress}`} title="Remove" disabled={disabled} onClick={() => void share.revokeInvite(person)}><X className="size-3.5" /></ShareButton> : null}
  </li>;
}

function InviteListFooter({ share, appUrl, disabled }: { share: ShareController; appUrl: string | null; disabled: boolean }) {
  const copy = useCopy();
  // The link is the only way people learn about access: no email is sent.
  const linkReady = share.pageMode === "private_email" && share.site?.status === "published" && appUrl;
  return <>
    {share.invitationsNextCursor ? <ShareButton size="sm" className="self-start" disabled={disabled} onClick={() => void share.loadMoreInvitations()}>Load more invitations</ShareButton> : null}
    {share.invitationsPaged ? <ShareButton variant="link" size="sm" className="self-start" disabled={share.operation !== null} onClick={share.showNewestInvitations}>Show newest invitations</ShareButton> : null}
    {linkReady ? <ShareButton size="sm" className="self-start" onClick={() => copy.copy("app", linkReady)}>
      <Link2 aria-hidden="true" className="size-3.5" />{copy.label("app", "Copy link")}
    </ShareButton> : null}
  </>;
}

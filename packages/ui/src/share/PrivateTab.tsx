"use client";
import { useId } from "react";
import { Ban, Check, Clock, Link2, RotateCw, X, type LucideIcon } from "lucide-react";
import type { EmailInvitationSummary } from "./email-invitations";
import { isInviteEmail } from "./share-model";
import { InlineError, ShareBadge, ShareButton, ShareInput, Spinner } from "./share-controls";
import type { ShareController } from "./use-share-controller";
import { useCopy } from "./use-copy";

type ShownInviteState = Exclude<EmailInvitationSummary["state"], "expired">;
const INVITE_STATUS: Record<ShownInviteState, { label: string; Icon: LucideIcon }> = {
  pending: { label: "Pending", Icon: Clock },
  accepted: { label: "Accepted", Icon: Check },
  revoked: { label: "Revoked", Icon: Ban },
};

/**
 * Shown only with the email-invite preview, or for a legacy one-time-link site
 * (spec 2693): one-time links are retired, so that site gets one line and a way
 * to stop sharing.
 */
export function PrivateTab({ share, ownerInitial, appUrl, draft, setDraft }: {
  share: ShareController; ownerInitial: string; appUrl: string | null; draft: string; setDraft: (value: string) => void;
}) {
  return <div className="flex flex-col gap-3">
    {share.pageMode === "private_link" ? <LegacyOneTimeLinks share={share} /> : null}
    {share.emailInvitesAvailable ? <InvitePeople share={share} ownerInitial={ownerInitial} appUrl={appUrl} draft={draft} setDraft={setDraft} /> : null}
  </div>;
}

function LegacyOneTimeLinks({ share }: { share: ShareController }) {
  return <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between gap-2">
      <span className="text-[13px] text-[var(--share-muted-fg)]">Uses retired one-time links</span>
      <ShareButton variant="link" disabled={share.operation !== null} onClick={() => void share.stopSharing()}>
        {share.operation === "stop" ? <Spinner /> : null}Stop sharing privately
      </ShareButton>
    </div>
    {share.error?.operation === "stop" ? <InlineError>{share.error.message}</InlineError> : null}
  </div>;
}

function InvitePeople({ share, ownerInitial, appUrl, draft, setDraft }: { share: ShareController; ownerInitial: string; appUrl: string | null; draft: string; setDraft: (value: string) => void }) {
  const inputId = useId();
  const copy = useCopy();
  const valid = isInviteEmail(draft);
  const inviting = share.operation === "invite";
  const busy = share.operation !== null;
  const submit = async () => {
    if (!valid || busy) return;
    const done = await share.request({ to: "private_email", email: draft.trim() });
    // A pending mode-switch confirm keeps the draft until the owner decides.
    if (done) setDraft("");
  };
  const people = share.pageMode === "private_email" ? share.invitations : [];
  return <>
    <div className="flex gap-2">
      <label htmlFor={inputId} className="sr-only">Email address</label>
      <ShareInput id={inputId} type="email" autoComplete="off" placeholder="Invite by email" value={draft}
        disabled={share.loading || share.loadFailed}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }} />
      <ShareButton variant="primary" disabled={!valid || busy || share.loading || share.loadFailed} onClick={() => void submit()}>
        {inviting ? <Spinner /> : null}Invite
      </ShareButton>
    </div>
    {share.error?.operation === "invite" || share.error?.operation === "invite_change" ? <InlineError>{share.error.message}</InlineError> : null}
    <ul aria-label="People with access" className="m-0 flex list-none flex-col p-0">
      <li className="flex h-10 items-center gap-2.5">
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--share-primary)] text-xs font-semibold text-[var(--share-primary-fg)]">{ownerInitial}</span>
        <span className="min-w-0 flex-1 text-[13px] font-medium">You</span>
        <ShareBadge>Owner</ShareBadge>
      </li>
      {people.map((person) => <li key={person.id} className="flex h-10 items-center gap-2.5">
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--share-muted)] text-xs font-semibold">{person.emailAddress.charAt(0).toUpperCase()}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{person.emailAddress}</span>
        {person.state === "expired"
          ? <ShareButton variant="ghost" size="icon" aria-label={`Resend invite to ${person.emailAddress}`} title="Resend" disabled={busy} onClick={() => void share.resendInvite(person)}><RotateCw className="size-3.5" /></ShareButton>
          : <InviteStatus state={person.state} />}
        <ShareButton variant="ghost" size="icon" aria-label={`Remove ${person.emailAddress}`} disabled={busy} onClick={() => void share.revokeInvite(person)}><X className="size-3.5" /></ShareButton>
      </li>)}
    </ul>
    {share.pageMode === "private_email" && people.length > 0 && appUrl ? <ShareButton size="sm" className="self-start" onClick={() => copy.copy("app", appUrl)}>
      <Link2 aria-hidden="true" className="size-3.5" />{copy.label("app", "Copy link")}
    </ShareButton> : null}
  </>;
}

function InviteStatus({ state }: { state: ShownInviteState }) {
  const { label, Icon } = INVITE_STATUS[state];
  return <span role="img" aria-label={label} title={label} className="flex size-7 shrink-0 items-center justify-center text-[var(--share-subtle-fg)]"><Icon aria-hidden="true" className="size-3.5" /></span>;
}

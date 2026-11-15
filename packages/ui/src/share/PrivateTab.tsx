"use client";
import { useId } from "react";
import { ChevronRight, Link2, Plus, X } from "lucide-react";
import type { SiteAccessLinkSummary } from "@matrix-os/contracts";
import type { EmailInvitationSummary } from "./email-invitations";
import { isInviteEmail, oneTimeLinkLabel } from "./share-model";
import { InlineError, ShareButton, ShareCollapsible, ShareCollapsibleContent, ShareCollapsibleTrigger, ShareInput, Spinner } from "./share-controls";
import { cn } from "./share-cn";
import type { ShareController } from "./use-share-controller";
import { useCopy } from "./use-copy";

const STATUS: Record<SiteAccessLinkSummary["status"], string> = { unclaimed: "Unclaimed", claimed: "Claimed", expired: "Expired" };
const INVITE_STATUS: Record<EmailInvitationSummary["state"], string> = { pending: "Pending", accepted: "Accepted", expired: "Expired", revoked: "Revoked" };

export interface PrivateTabState {
  draft: string;
  setDraft: (value: string) => void;
  linksOpen: boolean;
  setLinksOpen: (open: boolean) => void;
}

export function PrivateTab({ share, ownerInitial, appUrl, state }: { share: ShareController; ownerInitial: string; appUrl: string | null; state: PrivateTabState }) {
  const privateOn = share.pageMode === "private_link" || share.pageMode === "private_email";
  return <div className="flex flex-col gap-3">
    <InvitePeople share={share} ownerInitial={ownerInitial} appUrl={appUrl} draft={state.draft} setDraft={state.setDraft} />
    <OneTimeLinks share={share} open={state.linksOpen} setOpen={state.setLinksOpen} />
    {privateOn ? <div className="-mt-1 flex flex-col items-end gap-1">
      <ShareButton variant="link" disabled={share.operation !== null} onClick={() => void share.stopSharing()}>
        {share.operation === "stop" ? <Spinner /> : null}Stop sharing privately
      </ShareButton>
      {share.error?.operation === "stop" ? <InlineError>{share.error.message}</InlineError> : null}
    </div> : null}
  </div>;
}

function InvitePeople({ share, ownerInitial, appUrl, draft, setDraft }: { share: ShareController; ownerInitial: string; appUrl: string | null; draft: string; setDraft: (value: string) => void }) {
  const inputId = useId();
  const copy = useCopy();
  const available = share.emailInvitesAvailable;
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
        disabled={!available || share.loading || share.loadFailed}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }} />
      <ShareButton variant="primary" disabled={!available || !valid || busy || share.loading || share.loadFailed} onClick={() => void submit()}>
        {inviting ? <Spinner /> : null}Invite
      </ShareButton>
    </div>
    {!available ? <p className="m-0 -mt-1 text-xs text-[var(--share-subtle-fg)]">Email invitations aren’t available yet. Use one-time links for now.</p> : null}
    {share.error?.operation === "invite" || share.error?.operation === "invite_change" ? <InlineError>{share.error.message}</InlineError> : null}
    <ul aria-label="People with access" className="m-0 flex list-none flex-col p-0">
      <li className="flex h-10 items-center gap-2.5">
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--share-primary)] text-xs font-semibold text-[var(--share-primary-fg)]">{ownerInitial}</span>
        <span className="min-w-0 flex-1 text-[13px] font-medium">You</span>
        <span className="text-[13px] text-[var(--share-muted-fg)]">Owner</span>
      </li>
      {people.map((person) => <li key={person.id} className="flex h-10 items-center gap-2.5">
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--share-muted)] text-xs font-semibold">{person.emailAddress.charAt(0).toUpperCase()}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{person.emailAddress}</span>
        {person.state === "expired"
          ? <ShareButton variant="link" disabled={busy} onClick={() => void share.resendInvite(person)}>Resend</ShareButton>
          : <span className="text-xs text-[var(--share-subtle-fg)]">{INVITE_STATUS[person.state]}</span>}
        <ShareButton variant="ghost" size="icon" aria-label={`Remove ${person.emailAddress}`} disabled={busy} onClick={() => void share.revokeInvite(person)}><X className="size-3.5" /></ShareButton>
      </li>)}
    </ul>
    {share.pageMode === "private_email" && people.length > 0 && appUrl ? <div className="flex items-center gap-2.5 border-t border-[var(--share-border)] pt-3">
      <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--share-muted)]"><Link2 className="size-3.5" /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-[13px] font-medium">App link</span>
        <span className="text-xs text-[var(--share-muted-fg)]">Invited people sign in to open it</span>
      </span>
      <ShareButton size="sm" className="h-9 px-3 text-[13px]" onClick={() => copy.copy("app", appUrl)}>{copy.label("app", "Copy link")}</ShareButton>
    </div> : null}
  </>;
}

function OneTimeLinks({ share, open, setOpen }: { share: ShareController; open: boolean; setOpen: (open: boolean) => void }) {
  const contentId = useId();
  const copy = useCopy();
  const links = share.pageMode === "private_link" ? share.links : [];
  const siteId = share.site?.id ?? "";
  const creating = share.operation === "link_create";
  const busy = share.operation !== null;
  return <ShareCollapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-1 border-t border-[var(--share-border)] pt-2">
    <ShareCollapsibleTrigger aria-controls={contentId} className="flex h-8 w-full items-center gap-2 bg-transparent p-0 text-left">
      <ChevronRight aria-hidden="true" className={cn("size-3.5 text-[var(--share-subtle-fg)] transition-transform", open && "rotate-90")} />
      <span className="text-[13px] font-medium">One-time links</span>
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--share-subtle-fg)]">Open once, in any browser</span>
      {links.length > 0 ? <span aria-label={`${links.length} links`} className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--share-muted)] px-1.5 text-xs font-medium">{links.length}</span> : null}
    </ShareCollapsibleTrigger>
    <ShareCollapsibleContent id={contentId} className="flex flex-col gap-0.5 pl-[22px]">
      <ul aria-label="One-time links" className="m-0 flex list-none flex-col gap-0.5 p-0">
        {links.map((link) => {
          const fresh = share.freshLinks[link.id];
          return <li key={link.id} className="flex h-8 items-center gap-2">
            <span className={cn("ph-no-capture min-w-0 flex-1 truncate font-mono text-xs", link.status === "expired" ? "text-[var(--share-subtle-fg)] opacity-70" : "")} data-ph-mask="true">{oneTimeLinkLabel(siteId, link.id)}</span>
            <span className="shrink-0 text-xs text-[var(--share-subtle-fg)]">{STATUS[link.status]}</span>
            {fresh ? <ShareButton size="sm" className="h-7 px-2" onClick={() => copy.copy(link.id, fresh)}>{copy.label(link.id, "Copy")}</ShareButton> : null}
            {link.status !== "expired" ? <ShareButton variant="ghost" size="icon" aria-label={`Revoke one-time link ${link.id.slice(0, 4)}`} disabled={busy} onClick={() => void share.revokeLink(link.id)}><X className="size-3.5" /></ShareButton> : null}
          </li>;
        })}
      </ul>
      {share.linksNextCursor ? <ShareButton variant="link" className="self-start" disabled={busy} onClick={() => void share.loadMoreLinks()}>Show more links</ShareButton> : null}
      <ShareButton size="sm" disabled={busy || share.loading || share.loadFailed} className="mt-0.5 h-[30px] self-start border-dashed border-[var(--share-input)] pl-2" onClick={async () => {
        const created = await share.request({ to: "private_link" });
        if (created) setOpen(true);
      }}>{creating ? <Spinner /> : <Plus className="size-3.5" />}New one-time link</ShareButton>
      {share.error?.operation === "link_create" || share.error?.operation === "link_revoke" ? <InlineError>{share.error.message}</InlineError> : null}
      <p className="m-0 mt-1 text-xs leading-4 text-[var(--share-subtle-fg)]">Copy a link right after creating it; it can’t be shown again. Unclaimed links expire after 7 days; an opened link works in that browser for 30 days.</p>
    </ShareCollapsibleContent>
  </ShareCollapsible>;
}

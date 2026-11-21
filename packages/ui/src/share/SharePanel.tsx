"use client";
import { useState, type ReactNode } from "react";
import { Building2, Globe, Lock, X } from "lucide-react";
import { ModeSwitchConfirm } from "./ModeSwitchConfirm";
import { PrivateTab } from "./PrivateTab";
import { PublicTab, type PublicDraft } from "./PublicTab";
import { BusyStatus, OnDot, ShareButton, ShareTabs, ShareTabsContent, ShareTabsList, ShareTabsTrigger } from "./share-controls";
import { defaultShareTab, privateTabVisible, tabIndicators, type ShareTab } from "./share-model";
import type { ShareSiteClient } from "./share-site-client";
import type { ShareController } from "./use-share-controller";
import { useSlugAvailability } from "./use-slug-availability";
import "./share.css";

/** Organization tab content supplied by the host (spec 2689). Hidden when the user has no org. */
export interface ShareOrganizationSlot {
  content: ReactNode;
  shared: boolean;
}

export interface SharePanelProps {
  share: ShareController;
  appSlug: string;
  appName: string;
  client: ShareSiteClient;
  ownerInitial: string;
  onClose: () => void;
  organization?: ShareOrganizationSlot | null;
  /** Visitor submissions view; hosts pass it only for apps with public forms. */
  submissions?: ReactNode;
}

/** The owner's chosen tab while it still exists, else the tab whose sharing is on. */
function resolveTab(chosen: ShareTab | null, share: ShareController, organization: ShareOrganizationSlot | null | undefined): ShareTab {
  const available = (tab: ShareTab) => tab === "public"
    || (tab === "organization" && Boolean(organization))
    || (tab === "private" && privateTabVisible(share.pageMode, share.emailInvitesAvailable));
  if (chosen && available(chosen)) return chosen;
  const fallback = defaultShareTab(share.pageMode, organization?.shared ?? false);
  return available(fallback) ? fallback : "public";
}

/** Public-tab draft: server values until the owner edits a field. */
function usePublicDraft(share: ShareController, appName: string) {
  const [edits, setEdits] = useState<Partial<PublicDraft>>({});
  const draft: PublicDraft = {
    slug: share.site?.slug ?? "", title: share.site?.title ?? appName, description: share.site?.description ?? "", metaOpen: false,
    ...edits,
  };
  return { draft, setDraft: (next: Partial<PublicDraft>) => setEdits((current) => ({ ...current, ...next })) };
}

export function SharePanel({ share, appSlug, appName, client, ownerInitial, onClose, organization, submissions }: SharePanelProps) {
  const [chosenTab, setChosenTab] = useState<ShareTab | null>(null);
  const tab = resolveTab(chosenTab, share, organization);
  const showPrivate = privateTabVisible(share.pageMode, share.emailInvitesAvailable);
  const [inviteDraft, setInviteDraft] = useState("");
  const { draft, setDraft } = usePublicDraft(share, appName);
  const slugState = useSlugAvailability({ client, appSlug, slug: draft.slug, currentSlug: share.site?.slug ?? null, conflict: share.slugConflict });
  const metadata = { title: draft.title.trim() || appName, description: draft.description.trim(), slug: draft.slug || null };
  const publish = () => void share.request({ to: "public", metadata });
  const confirm = async () => {
    const target = share.pendingSwitch?.to;
    if (!await share.confirmSwitch()) return;
    if (target === "private_email") setInviteDraft("");
  };
  return <section aria-label="Share app" className="matrix-share flex max-h-[inherit] min-h-0 w-full flex-col rounded-[14px]">
    <header className="flex shrink-0 items-center justify-between pb-0.5 pl-4 pr-2.5 pt-2.5">
      <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Share</h2>
      <ShareButton variant="ghost" size="icon" className="size-9 rounded-lg" aria-label="Close" onClick={onClose}><X className="size-4" /></ShareButton>
    </header>
    <ShareTabs value={tab} onValueChange={(value) => setChosenTab(value as ShareTab)} className="flex min-h-0 flex-col gap-3.5 overflow-y-auto overscroll-contain px-4 pb-4 pt-2">
      <ShareTabBar share={share} organization={organization} showPrivate={showPrivate} />
      <LoadState share={share} />
      {showPrivate ? <ShareTabsContent value="private" className="outline-none">
        <PrivateTab share={share} ownerInitial={ownerInitial} appUrl={share.site ? `https://matrix.page/${share.site.id}` : null}
          draft={inviteDraft} setDraft={setInviteDraft} />
      </ShareTabsContent> : null}
      {organization ? <ShareTabsContent value="organization" className="outline-none">{organization.content}</ShareTabsContent> : null}
      <ShareTabsContent value="public" className="outline-none">
        <PublicTab share={share} draft={draft} setDraft={setDraft} slugState={slugState} onPublish={publish}
          onSaveDetails={() => void share.saveDetails(metadata)} submissions={submissions} />
      </ShareTabsContent>
      {share.pendingSwitch && share.pageMode !== "none" ? <ModeSwitchConfirm
        current={share.pageMode} target={share.pendingSwitch.to} invitedCount={share.invitationsNextCursor || share.invitationsPaged || !share.emailInvitesAvailable ? null : share.invitations.filter((invitation) => invitation.state === "pending" || invitation.state === "accepted").length}
        pending={share.operation === "switch"} error={share.error?.operation === "switch" ? share.error.message : null}
        onConfirm={() => void confirm()} onCancel={share.cancelSwitch} /> : null}
    </ShareTabs>
  </section>;
}

/** Tabs are navigation only; the dot shows which sharing is on. */
function ShareTabBar({ share, organization, showPrivate }: { share: ShareController; organization?: ShareOrganizationSlot | null; showPrivate: boolean }) {
  const dots = tabIndicators(share.pageMode, organization?.shared ?? false);
  return <ShareTabsList aria-label="Sharing options">
    {showPrivate ? <ShareTabsTrigger value="private"><Lock aria-hidden="true" className="size-[15px]" /><span className="min-w-0 truncate">Private</span>{dots.private ? <OnDot /> : null}</ShareTabsTrigger> : null}
    {organization ? <ShareTabsTrigger value="organization"><Building2 aria-hidden="true" className="size-[15px]" /><span className="min-w-0 truncate">Organization</span>{dots.organization ? <OnDot /> : null}</ShareTabsTrigger> : null}
    <ShareTabsTrigger value="public"><Globe aria-hidden="true" className="size-[15px]" /><span className="min-w-0 truncate">Public</span>{dots.public ? <OnDot /> : null}</ShareTabsTrigger>
  </ShareTabsList>;
}

function LoadState({ share }: { share: ShareController }) {
  if (share.loading) return <BusyStatus label="Loading" className="justify-center py-1" />;
  if (!share.loadFailed) return null;
  return <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--share-border)] p-2.5">
    <p role="alert" className="m-0 text-xs">Couldn’t load.</p>
    <ShareButton size="sm" onClick={share.retry}>Retry</ShareButton>
  </div>;
}

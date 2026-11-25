"use client";
import type { ReactNode } from "react";
import { Check, ExternalLink, Link2, Users, X } from "lucide-react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Select, SelectContent, SelectGroup, SelectLabel, SelectTrigger } from "../Select";
import { InlineError, ShareBadge, ShareButton, Spinner } from "./share-controls";
import { cn } from "./share-cn";
import { membersLabel, organizationColor, organizationInitial, type ShareOrganization } from "./organization-identity";
import type { OrganizationShareFlow } from "./use-organization-share-flow";
import { useCopy } from "./use-copy";

function OrgAvatar({ organization, size }: { organization: ShareOrganization; size: "sm" | "md" }) {
  return <span aria-hidden="true" style={{ background: organizationColor(organization.organizationId) }}
    className={size === "md" ? "flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white" : "flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[10px] font-semibold text-white"}>
    {organizationInitial(organization.name)}
  </span>;
}

const CARD = "flex h-12 w-full items-center gap-1.5 rounded-lg border border-[var(--share-border)] bg-[var(--share-bg)] pr-2 shadow-xs";

function OrgSummary({ organization }: { organization: ShareOrganization }) {
  return <>
    <OrgAvatar organization={organization} size="md" />
    <span className="flex min-w-0 flex-1 flex-col gap-px text-left">
      <span className="truncate text-[13px] font-semibold">{organization.name}</span>
      <span className="text-xs text-[var(--share-subtle-fg)]">{membersLabel(organization.memberCount)}</span>
    </span>
  </>;
}

/**
 * Org card: avatar, name, member count and a trailing slot for the share
 * controls. With several orgs (and nothing pinned) the summary is a Select
 * trigger; the trailing controls stay its siblings, never nested in it.
 */
function OrganizationCard({ organizations, selected, onSelect, pinned, trailing }: {
  organizations: ShareOrganization[]; selected: ShareOrganization; onSelect: (id: string) => void; pinned: boolean; trailing: ReactNode;
}) {
  // One org, or an org pinned by a live share / running setup: static summary, no chevron (design).
  if (organizations.length === 1 || pinned) {
    return <div role="group" aria-label={`Share in ${selected.name}`} className={cn(CARD, "pl-3")}>
      <span className="flex min-w-0 flex-1 items-center gap-2.5"><OrgSummary organization={selected} /></span>
      {trailing}
    </div>;
  }
  return <div className={CARD}>
    <Select value={selected.organizationId} onValueChange={onSelect}>
      <SelectTrigger aria-label={`Share in ${selected.name}, change organization`} className="h-full min-w-0 flex-1 gap-2.5 rounded-l-lg rounded-r-none border-0 bg-transparent pl-3 pr-1 text-[var(--share-fg)] shadow-none dark:bg-transparent">
        <OrgSummary organization={selected} />
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={4} className="matrix-share w-[var(--radix-select-trigger-width)] rounded-lg">
        <SelectGroup>
          <SelectLabel className="px-2 py-1.5 text-xs font-medium text-[var(--share-subtle-fg)]">Share in</SelectLabel>
          {organizations.map((organization) => <SelectPrimitive.Item key={organization.organizationId} value={organization.organizationId}
            className="relative flex h-9 cursor-default select-none items-center gap-2 rounded-[4px] pl-2 pr-8 text-[13px] text-[var(--share-fg)] outline-none data-[highlighted]:bg-[var(--share-muted)] data-[state=checked]:bg-[var(--share-muted)]">
            <OrgAvatar organization={organization} size="sm" />
            <SelectPrimitive.ItemText asChild><span className="min-w-0 flex-1 truncate">{organization.name}</span></SelectPrimitive.ItemText>
            <span className="text-xs text-[var(--share-subtle-fg)]">{organization.memberCount}</span>
            <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center"><Check aria-hidden="true" className="size-3.5" strokeWidth={2.4} /></SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>)}
        </SelectGroup>
      </SelectContent>
    </Select>
    {trailing}
  </div>;
}

/** Shared state: badge, copy-link and stop icon buttons. Stopping is one click and reversible. */
function SharedControls({ name, orgLink, busy, viewOnly, onStop }: { name: string; orgLink: string | null; busy: boolean; viewOnly: boolean; onStop: () => void }) {
  const copy = useCopy();
  const copyState = copy.label("org", "");
  return <>
    <ShareBadge tone="success"><Check aria-hidden="true" strokeWidth={2.6} />{viewOnly ? "Shared · View only" : "Shared"}</ShareBadge>
    <ShareButton variant="ghost" size="icon" className="size-8" aria-label={`Copy ${name} link`} title={copyState || `Copy ${name} link`} disabled={!orgLink}
      onClick={() => { if (orgLink) copy.copy("org", orgLink); }}>
      {copyState === "Copied" ? <Check className="size-3.5 text-[var(--share-success-fg)]" /> : <Link2 className="size-3.5" />}
    </ShareButton>
    <span className="sr-only" aria-live="polite">{copyState}</span>
    <ShareButton variant="ghost" size="icon" className="size-8 hover:bg-[var(--share-danger-bg)] hover:text-[var(--share-danger-fg)]" aria-label={`Stop sharing with ${name}`} title={`Stop sharing with ${name}`} disabled={busy} onClick={onStop}>
      <X className="size-3.5" />
    </ShareButton>
  </>;
}

function DoneCard({ onDismiss }: { onDismiss: () => void }) {
  return <div className="flex gap-3 rounded-xl bg-[var(--share-success-bg)] p-3">
    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--share-bg)] text-[var(--share-success-fg)] shadow-[0_0_0_1px_#BBF7D0]"><Check className="size-4" strokeWidth={2.4} /></span>
    <div role="status" className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-[13px] font-semibold">Collaborative and shared</span>
      <ShareButton size="sm" className="mt-2 self-start border-[#BBF7D0]" onClick={onDismiss}>Got it</ShareButton>
    </div>
  </div>;
}

// react-doctor-disable-next-line react-doctor/no-high-complexity-react-function -- one view switch over the org-share flow steps (idle, checking, shared, setting up, done); each step's body is already its own component.
export function OrganizationTab({ organizations, selectedId, onSelect, flow, orgLink, onOpenChat, busy }: {
  organizations: ShareOrganization[];
  selectedId: string;
  onSelect: (organizationId: string) => void;
  flow: OrganizationShareFlow;
  /** Web URL members open; wraps the `/shared/app/<scopeId>` deep link. */
  orgLink: string | null;
  onOpenChat: () => void;
  busy: boolean;
}) {
  const selected = organizations.find((organization) => organization.organizationId === selectedId) ?? organizations[0];
  if (!selected) return null;
  const name = selected.name;
  const settingUp = flow.step === "running" || flow.step === "applying";
  const canShare = !flow.shared && flow.step !== "applying";
  const trailing = flow.shared
    ? <SharedControls name={name} orgLink={orgLink} busy={busy} viewOnly={flow.viewOnly} onStop={() => void flow.stop()} />
    : canShare ? <ShareButton variant="primary" size="sm" aria-label={`Share with ${name}`} disabled={busy || flow.step === "checking"} onClick={() => flow.share(selected.organizationId)}>
      {flow.step === "checking" ? <Spinner /> : null}Share
    </ShareButton> : null;
  return <div className="flex flex-col gap-3">
    <OrganizationCard organizations={organizations} selected={selected} onSelect={onSelect} pinned={flow.shared || settingUp || busy} trailing={trailing} />
    {flow.step === "done" ? <DoneCard onDismiss={flow.dismissDone} />
      : <CollaborativeSuggestion flow={flow} organizationId={selected.organizationId} onOpenChat={onOpenChat} />}
    {flow.notice ? <InlineError>{flow.notice}</InlineError> : null}
  </div>;
}

function suggestionText(flow: OrganizationShareFlow, collaborative: boolean, settingUp: boolean): string {
  if (collaborative) return "Everyone can view and edit the same data.";
  if (settingUp) return "Setting up…";
  if (flow.viewOnly) return "Teammates can view but not edit. Claude can set up shared editing in a new chat.";
  return flow.shared
    ? "Claude can set up shared editing in a new chat."
    : "Teammates can view it once shared. Claude can set up shared editing in a new chat.";
}

function SuggestionIcon({ collaborative, settingUp }: { collaborative: boolean; settingUp: boolean }) {
  if (collaborative) {
    return <span role="img" aria-label="Done" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--share-success-bg)] text-[var(--share-success-fg)]"><Check aria-hidden="true" className="size-3.5" strokeWidth={2.6} /></span>;
  }
  return <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--share-input)] bg-[var(--share-bg)] text-[var(--share-subtle-fg)]">{settingUp ? <Spinner className="size-[13px]" /> : <Users className="size-3.5" />}</span>;
}

function SuggestionActions({ flow, organizationId, settingUp, onOpenChat }: { flow: OrganizationShareFlow; organizationId: string; settingUp: boolean; onOpenChat: () => void }) {
  if (settingUp) {
    return <div className="mt-2 flex items-center gap-2">
      <ShareButton size="sm" className="font-semibold" onClick={onOpenChat}>Open chat<ExternalLink aria-hidden="true" className="size-[13px]" /></ShareButton>
      <ShareButton variant="link" onClick={() => void flow.cancel()}>Cancel</ShareButton>
    </div>;
  }
  return <div className="mt-2 flex items-center gap-2">
    <ShareButton size="sm" onClick={() => void flow.startInChats(organizationId)}>Start in Chats<ExternalLink aria-hidden="true" className="size-[13px]" /></ShareButton>
  </div>;
}

/**
 * ENG-579: making the app collaborative is an optional suggestion. It stays in the tab and shows a
 * green tick once the current build is collaborative; until then members can only view.
 */
function CollaborativeSuggestion({ flow, organizationId, onOpenChat }: { flow: OrganizationShareFlow; organizationId: string; onOpenChat: () => void }) {
  const settingUp = flow.step === "running" || flow.step === "applying";
  // A finished setup still applying its share keeps Cancel until the share settles.
  const collaborative = flow.collaborative && !settingUp;
  return <section aria-label="Make it collaborative" className="flex gap-3 rounded-xl border border-[var(--share-border)] bg-[var(--share-panel)] p-3">
    <SuggestionIcon collaborative={collaborative} settingUp={settingUp} />
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
      <span className="text-[13px] font-semibold">{collaborative ? "Collaborative" : "Make it collaborative"}</span>
      <span className="text-xs leading-[17px] text-[var(--share-muted-fg)]">{suggestionText(flow, collaborative, settingUp)}</span>
      {collaborative ? null : <SuggestionActions flow={flow} organizationId={organizationId} settingUp={settingUp} onOpenChat={onOpenChat} />}
    </div>
  </section>;
}

"use client";
import { Check, ExternalLink, Link2 } from "lucide-react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Select, SelectContent, SelectGroup, SelectLabel, SelectTrigger } from "../Select";
import { InlineError, ShareButton, Spinner } from "./share-controls";
import { membersLabel, organizationColor, organizationInitial, type ShareOrganization } from "./organization-identity";
import type { OrganizationShareFlow } from "./use-organization-share-flow";
import { useCopy } from "./use-copy";

function OrgAvatar({ organization, size }: { organization: ShareOrganization; size: "sm" | "md" }) {
  return <span aria-hidden="true" style={{ background: organizationColor(organization.organizationId) }}
    className={size === "md" ? "flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white" : "flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[10px] font-semibold text-white"}>
    {organizationInitial(organization.name)}
  </span>;
}

function OrganizationPicker({ organizations, selected, onSelect, disabled }: {
  organizations: ShareOrganization[]; selected: ShareOrganization; onSelect: (id: string) => void; disabled: boolean;
}) {
  const summary = <>
    <OrgAvatar organization={selected} size="md" />
    <span className="flex min-w-0 flex-1 flex-col gap-px text-left">
      <span className="truncate text-[13px] font-semibold">{selected.name}</span>
      <span className="text-xs text-[var(--share-subtle-fg)]">{membersLabel(selected.memberCount)}</span>
    </span>
  </>;
  const box = "flex h-12 w-full items-center gap-2.5 rounded-lg border border-[var(--share-border)] bg-[var(--share-bg)] px-3 shadow-xs";
  // One org, or an org pinned by a live share / running setup: static summary, no chevron (design).
  if (organizations.length === 1 || disabled) return <div className={box} aria-label={`Share in ${selected.name}`}>{summary}</div>;
  return <Select value={selected.organizationId} onValueChange={onSelect}>
    <SelectTrigger aria-label={`Share in ${selected.name}, change organization`} className={`${box} h-12 text-[var(--share-fg)]`}>{summary}</SelectTrigger>
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
  </Select>;
}

function SharedLink({ name, orgLink, busy, onStop }: { name: string; orgLink: string | null; busy: boolean; onStop: () => void }) {
  const copy = useCopy();
  return <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2.5 border-t border-[var(--share-border)] pt-3">
      <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--share-muted)]"><Link2 className="size-3.5" /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-[13px] font-medium">{name} link</span>
        <span className="text-xs text-[var(--share-muted-fg)]">Opens it in the Matrix app</span>
      </span>
      <ShareButton size="sm" className="h-9 px-3 text-[13px]" disabled={!orgLink} onClick={() => { if (orgLink) copy.copy("org", orgLink); }}>{copy.label("org", "Copy link")}</ShareButton>
    </div>
    <ShareButton variant="link" className="self-end" disabled={busy} onClick={onStop}>Stop sharing with {name}</ShareButton>
  </div>;
}

function DoneCard({ name, onDismiss }: { name: string; onDismiss: () => void }) {
  return <div className="flex gap-3 rounded-xl bg-[var(--share-success-bg)] p-3">
    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--share-bg)] text-[var(--share-success-fg)] shadow-[0_0_0_1px_#BBF7D0]"><Check className="size-4" strokeWidth={2.4} /></span>
    <div role="status" className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-[13px] font-semibold">Collaborative and shared</span>
      <span className="text-xs leading-[17px] text-[var(--share-muted-fg)]">Everyone at {name} sees the same, live data.</span>
      <ShareButton size="sm" className="mt-2 self-start border-[#BBF7D0]" onClick={onDismiss}>Got it</ShareButton>
    </div>
  </div>;
}

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
  const steps = flow.step === "required" || flow.step === "running" || flow.step === "applying";
  return <div className="flex flex-col gap-3">
    <OrganizationPicker organizations={organizations} selected={selected} onSelect={onSelect} disabled={flow.shared || steps || busy} />
    {(flow.step === "idle" && !flow.shared) || flow.step === "checking"
      ? <ShareButton variant="primary" disabled={busy || flow.step === "checking"} onClick={() => flow.share(selected.organizationId)}>
        {flow.step === "checking" ? <Spinner /> : null}Share with {name}
      </ShareButton> : null}
    {flow.shared && flow.step !== "done" ? <SharedLink name={name} orgLink={orgLink} busy={busy} onStop={() => void flow.stop()} /> : null}
    {steps ? <CollaborativeSteps flow={flow} name={name} organizationId={selected.organizationId} onOpenChat={onOpenChat} /> : null}
    {flow.step === "done" ? <DoneCard name={name} onDismiss={flow.dismissDone} /> : null}
    {flow.notice ? <InlineError>{flow.notice}</InlineError> : null}
  </div>;
}

function CollaborativeSteps({ flow, name, organizationId, onOpenChat }: { flow: OrganizationShareFlow; name: string; organizationId: string; onOpenChat: () => void }) {
  const busy = flow.step === "running" || flow.step === "applying";
  return <ol aria-label="Two steps to share" className="m-0 flex list-none flex-col rounded-xl border border-[var(--share-border)] bg-[var(--share-panel)] p-3">
    <li className="flex gap-3">
      <span className="flex shrink-0 flex-col items-center">
        <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-full bg-[var(--share-primary)] text-xs font-semibold text-[var(--share-primary-fg)]">{busy ? <Spinner className="size-[13px]" /> : "1"}</span>
        <span aria-hidden="true" className="my-1 min-h-3 w-px flex-1 bg-[var(--share-input)]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pb-3.5 pt-0.5">
        <span className="text-[13px] font-semibold">Make it collaborative</span>
        <span className="text-xs leading-[17px] text-[var(--share-muted-fg)]">{busy ? "Claude is setting it up in a new chat." : "Claude sets it up in a new chat so everyone sees the same, up-to-date data."}</span>
        <div className="mt-2 flex gap-2">
          {busy
            ? <ShareButton size="sm" className="font-semibold" onClick={onOpenChat}>Open chat<ExternalLink aria-hidden="true" className="size-[13px]" /></ShareButton>
            : <ShareButton variant="primary" size="sm" onClick={() => void flow.startInChats(organizationId)}>Start in Chats<ExternalLink aria-hidden="true" className="size-[13px]" /></ShareButton>}
        </div>
      </div>
    </li>
    <li className="flex gap-3">
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--share-input)] bg-[var(--share-bg)] text-xs font-semibold text-[var(--share-subtle-fg)]">2</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
        <span className="text-[13px] font-semibold text-[var(--share-muted-fg)]">Share with {name}</span>
        <span className="text-xs leading-[17px] text-[var(--share-subtle-fg)]">Turns on by itself when step 1 is done.</span>
      </div>
    </li>
    <li className="mt-1.5 flex justify-end">
      <ShareButton variant="link" onClick={() => void flow.cancel()}>{busy ? "Cancel sharing" : "Cancel"}</ShareButton>
    </li>
  </ol>;
}

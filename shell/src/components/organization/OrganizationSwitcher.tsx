"use client";

import { useAuth, useOrganization, useOrganizationList } from "@clerk/nextjs";
import type { OrganizationManagementSummary } from "@matrix-os/contracts";
import { useCallback, useState } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { Check, ChevronDown, Plus, Settings, UserRound } from "@/lib/hugeicons";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { clearOrganizationSelection, readOrganizationSelection, writeOrganizationSelection } from "@/lib/organization-selection";
import { InviteMembersDialog } from "./OrganizationDialogs";
import { OrganizationMark } from "./OrganizationMark";
import { useShellOrganizations } from "./useShellOrganizations";
import { useShellOrganizationActions } from "./useShellOrganizationActions";

const MENU_ITEM = "flex min-h-9 cursor-default items-center gap-2.5 rounded-lg px-2 text-[13px] outline-none transition-colors data-[highlighted]:bg-foreground/[0.06]";

export function OrganizationSwitcherView({ organizations, organizationId, onSelect, onOpenSettings, onOpenInvite }: {
  organizations: readonly OrganizationManagementSummary[];
  organizationId: string | null;
  onSelect: (organizationId: string | null) => void;
  onOpenSettings: (organizationId: string) => void;
  onOpenInvite: (organization: OrganizationManagementSummary) => void;
}) {
  const active = organizationId
    ? organizations.find((organization) => organization.organizationId === organizationId) ?? organizations[0]
    : null;
  const admin = active?.role === "org:admin";
  return (
    <>
      <DropdownMenuPrimitive.Trigger asChild>
        <button type="button" aria-label={`Switch organization, current organization ${active?.name ?? "Personal"}`} className="flex h-7 max-w-[210px] items-center gap-2 rounded-lg border border-border/70 bg-card px-2 text-xs font-semibold shadow-sm outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring">
          {active ? <OrganizationMark name={active.name} className="size-5" /> : <span className="flex size-5 items-center justify-center rounded-md bg-muted text-muted-foreground"><UserRound className="size-3" /></span>}
          <span className="min-w-0 truncate">{active?.name ?? "Personal"}</span>
          <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="start" sideOffset={7} className="w-[286px] rounded-2xl border border-border/60 bg-popover p-2 text-popover-foreground shadow-[0_24px_70px_rgba(50,53,46,0.28)]" style={{ zIndex: SHELL_Z_INDEX.popover }}>
          <div className="flex items-center gap-3 px-2 py-2">
            {active ? <OrganizationMark name={active.name} className="size-9" /> : <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"><UserRound className="size-4" /></span>}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{active?.name ?? "Personal"}</p>
              {active && !admin ? <button type="button" aria-label={`View ${active.memberCount} ${active.memberCount === 1 ? "member" : "members"}`} onClick={() => onOpenSettings(active.organizationId)} className="text-xs text-muted-foreground hover:underline">{active.memberCount} {active.memberCount === 1 ? "member" : "members"}</button>
                : <p className="text-xs text-muted-foreground">{active ? `${active.memberCount} ${active.memberCount === 1 ? "member" : "members"}` : "Your private workspace"}</p>}
            </div>
          </div>
          {admin ? <div className="space-y-2 px-1 pb-2 pt-1">
            <DropdownMenuPrimitive.Item className={`${MENU_ITEM} min-h-7 justify-center border border-border`} onSelect={() => { if (active) onOpenInvite(active); }}><Plus className="size-4 text-muted-foreground" />Invite members</DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item className={`${MENU_ITEM} min-h-7 justify-center border border-border`} onSelect={() => { if (active) onOpenSettings(active.organizationId); }}><Settings className="size-4 text-muted-foreground" />Organization settings</DropdownMenuPrimitive.Item>
          </div> : null}
          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border/60" />
          <DropdownMenuPrimitive.Label className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Organizations</DropdownMenuPrimitive.Label>
          <DropdownMenuPrimitive.RadioGroup value={organizationId ?? "personal"}>
            <DropdownMenuPrimitive.RadioItem value="personal" className={MENU_ITEM} onSelect={() => onSelect(null)}>
              <span className="flex size-5 items-center justify-center rounded-md bg-muted text-muted-foreground"><UserRound className="size-3" /></span><span className="min-w-0 flex-1 truncate">Personal</span><DropdownMenuPrimitive.ItemIndicator><Check className="size-3.5 text-primary" /></DropdownMenuPrimitive.ItemIndicator>
            </DropdownMenuPrimitive.RadioItem>
            {organizations.map((organization) => <DropdownMenuPrimitive.RadioItem key={organization.organizationId} value={organization.organizationId} className={MENU_ITEM} onSelect={() => onSelect(organization.organizationId)}>
              <OrganizationMark name={organization.name} className="size-5" /><span className="min-w-0 flex-1 truncate">{organization.name}</span><DropdownMenuPrimitive.ItemIndicator><Check className="size-3.5 text-primary" /></DropdownMenuPrimitive.ItemIndicator>
            </DropdownMenuPrimitive.RadioItem>)}
          </DropdownMenuPrimitive.RadioGroup>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </>
  );
}

export function OrganizationSwitcher({ onOpenSettings }: { onOpenSettings: (section: "organization") => void }) {
  const { userId } = useAuth();
  const { organization } = useOrganization();
  const { isLoaded, setActive } = useOrganizationList();
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  const listing = useShellOrganizations(refreshKey);
  const [inviteOrganization, setInviteOrganization] = useState<OrganizationManagementSummary | null>(null);
  const [failedName, setFailedName] = useState<string | null>(null);
  const actions = useShellOrganizationActions(inviteOrganization?.organizationId ?? null, refresh);
  if (!isLoaded || !setActive || listing.state !== "loaded" || listing.organizations.length === 0) return null;

  const select = (organizationId: string | null) => {
    const actorId = userId ?? null;
    const previous = readOrganizationSelection(actorId);
    writeOrganizationSelection(actorId, organizationId ?? "personal");
    setFailedName(null);
    void setActive({ organization: organizationId }).catch((error: unknown) => {
      console.warn("[organization-management] activation failed", error instanceof Error ? error.name : "UnknownError");
      if (previous) writeOrganizationSelection(actorId, previous);
      else clearOrganizationSelection(actorId);
      setFailedName(organizationId ? listing.organizations.find((candidate) => candidate.organizationId === organizationId)?.name ?? "organization" : "Personal");
    });
  };

  return (
    <>
      <DropdownMenuPrimitive.Root>
        <OrganizationSwitcherView organizations={listing.organizations} organizationId={organization?.id ?? null} onSelect={select} onOpenSettings={() => onOpenSettings("organization")} onOpenInvite={setInviteOrganization} />
      </DropdownMenuPrimitive.Root>
      {failedName ? <span role="alert" className="sr-only">Couldn&apos;t switch to {failedName}. Try again.</span> : null}
      {actions.error ? <span role="alert" className="sr-only">{actions.error}</span> : null}
      {inviteOrganization ? <InviteMembersDialog organization={inviteOrganization} open busy={actions.busy} onOpenChange={(open) => { if (!open) setInviteOrganization(null); }} onSubmit={async (input) => {
        if (await actions.run((client) => client.invite(input.emailAddresses, input.role))) setInviteOrganization(null);
      }} /> : null}
    </>
  );
}

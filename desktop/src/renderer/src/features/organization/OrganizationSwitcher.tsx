import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { OrganizationManagementSummary } from "@matrix-os/contracts";
import { Check, ChevronDown, Plus, Settings, UserRound } from "@renderer/lib/hugeicons";
import { useCallback, useEffect, useState } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { useDesktopOrganizations } from "../collaboration/useDesktopOrganizations";
import { InviteMembersDialog } from "./OrganizationDialogs";
import { OrganizationMark } from "./OrganizationMark";
import { useDesktopOrganizationActions } from "./useDesktopOrganizationActions";

const MENU_ITEM = "flex min-h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] outline-none data-[highlighted]:bg-[var(--bg-hover)]";

export function OrganizationSwitcherView({
  organizations,
  organizationId,
  onSelect,
  onOpenSettings,
  onOpenInvite,
}: {
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
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Switch organization, current organization ${active?.name ?? "Personal"}`}
          className="no-drag flex h-8 max-w-[220px] items-center gap-2 rounded-md border px-2 outline-none transition-colors hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ borderColor: "transparent", background: "var(--bg-hover)", color: "var(--text-primary)" }}
        >
          {active ? <OrganizationMark name={active.name} size={22} /> : (
            <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md" style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}><UserRound size={13} /></span>
          )}
          <span className="min-w-0 truncate text-xs font-semibold">{active?.name ?? "Personal"}</span>
          <ChevronDown aria-hidden="true" size={13} style={{ color: "var(--text-tertiary)" }} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={6}
          align="end"
          className="w-[280px] rounded-xl border p-1.5 outline-none"
          style={{ zIndex: DESKTOP_Z_INDEX.popover, borderColor: "var(--border-default)", background: "var(--bg-overlay)", boxShadow: "var(--shadow-2)" }}
        >
          <div className="flex items-center gap-3 px-2 py-2">
            {active ? <OrganizationMark name={active.name} size={36} /> : (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}><UserRound size={17} /></span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{active?.name ?? "Personal"}</p>
              {active && !admin ? (
                <button type="button" aria-label={`View ${active.memberCount} ${active.memberCount === 1 ? "member" : "members"}`} onClick={() => onOpenSettings(active.organizationId)} className="text-xs hover:underline" style={{ color: "var(--text-tertiary)" }}>
                  {active.memberCount} {active.memberCount === 1 ? "member" : "members"}
                </button>
              ) : <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>{active ? `${active.memberCount} ${active.memberCount === 1 ? "member" : "members"}` : "Your private workspace"}</p>}
            </div>
          </div>
          {admin ? (
            <div className="space-y-2 px-1 pb-2 pt-1">
              <DropdownMenu.Item className={`${MENU_ITEM} min-h-7 justify-center border`} style={{ borderColor: "var(--border-default)" }} onSelect={() => { if (active) onOpenInvite(active); }}>
                <Plus aria-hidden="true" size={15} style={{ color: "var(--text-tertiary)" }} />
                Invite members
              </DropdownMenu.Item>
              <DropdownMenu.Item className={`${MENU_ITEM} min-h-7 justify-center border`} style={{ borderColor: "var(--border-default)" }} onSelect={() => { if (active) onOpenSettings(active.organizationId); }}>
                <Settings aria-hidden="true" size={15} style={{ color: "var(--text-tertiary)" }} />
                Organization settings
              </DropdownMenu.Item>
            </div>
          ) : null}
          <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
          <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[11px] font-normal" style={{ color: "var(--text-tertiary)" }}>
            Organizations
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={organizationId ?? "personal"}>
            <DropdownMenu.RadioItem value="personal" className={MENU_ITEM} onSelect={() => onSelect(null)}>
              <span className="flex size-[22px] items-center justify-center rounded-full text-xs" style={{ background: "var(--bg-hover)", color: "var(--text-tertiary)" }}>A</span>
              <span className="min-w-0 flex-1 truncate">Personal</span>
              <DropdownMenu.ItemIndicator><Check size={14} style={{ color: "var(--accent)" }} /></DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
            {organizations.map((organization) => (
              <DropdownMenu.RadioItem key={organization.organizationId} value={organization.organizationId} className={MENU_ITEM} onSelect={() => onSelect(organization.organizationId)}>
                <OrganizationMark name={organization.name} size={22} />
                <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                <DropdownMenu.ItemIndicator><Check size={14} style={{ color: "var(--accent)" }} /></DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </>
  );
}

export default function OrganizationSwitcher() {
  const [open, setOpen] = useState(false);
  const [inviteOrganization, setInviteOrganization] = useState<OrganizationManagementSummary | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const listing = useDesktopOrganizations(refreshKey);
  const organizationId = useConnection((state) => state.organizationId);
  const selectOrganization = useConnection((state) => state.selectOrganization);
  const openTab = useTabs((state) => state.openTab);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);
  const acquireRendererOverlay = useUi((state) => state.acquireRendererOverlay);
  const releaseRendererOverlay = useUi((state) => state.releaseRendererOverlay);
  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  const actions = useDesktopOrganizationActions(inviteOrganization?.organizationId ?? null, refresh);

  useEffect(() => {
    if (!open && !inviteOrganization) return;
    acquireRendererOverlay();
    return releaseRendererOverlay;
  }, [acquireRendererOverlay, inviteOrganization, open, releaseRendererOverlay]);

  if (listing.state !== "loaded" || listing.organizations.length === 0) return null;
  const openSettings = (selectedOrganizationId: string) => {
    selectOrganization(selectedOrganizationId);
    requestSettingsSection("organization");
    openTab({ kind: "settings", title: "Settings" });
  };

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <OrganizationSwitcherView
          organizations={listing.organizations}
          organizationId={organizationId}
          onSelect={selectOrganization}
          onOpenSettings={openSettings}
          onOpenInvite={setInviteOrganization}
        />
      </DropdownMenu.Root>
      {inviteOrganization ? (
        <InviteMembersDialog
          organization={inviteOrganization}
          open
          busy={actions.busy}
          onClose={() => setInviteOrganization(null)}
          onSubmit={async (input) => {
            if (await actions.run((client) => client.invite(input.emailAddresses, input.role))) setInviteOrganization(null);
          }}
        />
      ) : null}
    </>
  );
}

"use client";

import { useAuth, useOrganization, useOrganizationList } from "@clerk/nextjs";
import type { OrganizationManagementInvitation, OrganizationManagementMember, OrganizationManagementRole, OrganizationManagementSummary } from "@matrix-os/contracts";
import { useCallback, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "@/lib/hugeicons";
import { Button } from "@/components/ui/button";
import { DeleteOrganizationDialog, InviteMembersDialog, LeaveOrganizationDialog, MakeAdminDialog, RemoveMemberDialog, RenameOrganizationDialog } from "@/components/organization/OrganizationDialogs";
import { OrganizationMark } from "@/components/organization/OrganizationMark";
import { organizationInitials } from "@/components/organization/organization-mark";
import { useShellOrganizationDirectory } from "@/components/organization/useShellOrganizationDirectory";
import { useShellOrganizationActions } from "@/components/organization/useShellOrganizationActions";
import { useShellOrganizations } from "@/components/organization/useShellOrganizations";

function roleLabel(role: OrganizationManagementMember["role"]): string {
  return role === "org:admin" ? "Admin" : "Member";
}

function PersonMark({ name }: { name: string }) {
  return <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">{organizationInitials(name)}</span>;
}

export function OrganizationSectionView({
  organization,
  currentActorId,
  members,
  invitations,
  onOpenInvite,
  onChangeLogo,
  onRename,
  onMemberRoleChange,
  onOpenMemberActions,
  onResendInvitation,
  onRevokeInvitation,
  onMakeSomeoneAdmin,
  onLeave,
  onDelete,
  busy = false,
}: {
  organization: OrganizationManagementSummary;
  currentActorId: string | null;
  members: readonly OrganizationManagementMember[];
  invitations: readonly OrganizationManagementInvitation[];
  onOpenInvite: () => void;
  onChangeLogo?: () => void;
  onRename?: () => void;
  onMemberRoleChange?: (actorId: string, role: OrganizationManagementRole) => void;
  onOpenMemberActions?: (actorId: string) => void;
  onResendInvitation?: (invitationId: string) => void;
  onRevokeInvitation?: (invitationId: string) => void;
  onMakeSomeoneAdmin?: () => void;
  onLeave?: () => void;
  onDelete?: () => void;
  busy?: boolean;
}) {
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const admin = organization.role === "org:admin";
  const administrators = members.filter((member) => member.role === "org:admin");
  const lastAdmin = admin && members.length >= organization.memberCount && administrators.length === 1 && administrators[0]?.actorId === currentActorId;
  const description = admin ? `Details and members of ${organization.name}.` : `You’re a member of ${organization.name}.`;
  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6"><h2 className="text-lg font-semibold">Organization</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>
      <section className="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-card p-4">
        <div className="flex min-w-0 items-center gap-3"><OrganizationMark name={organization.name} className="size-11" /><div className="min-w-0"><h3 className="truncate text-[15px] font-semibold">{organization.name}</h3><p className="text-xs text-muted-foreground">{organization.memberCount} {organization.memberCount === 1 ? "member" : "members"}</p></div></div>
        {admin ? <div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={!onChangeLogo} onClick={onChangeLogo}>Change logo</Button><Button size="sm" variant="outline" disabled={!onRename} onClick={onRename}>Rename</Button></div> : null}
      </section>

      <div className="mt-6 flex items-center justify-between"><h3 className="text-sm font-medium">Members</h3>{admin ? <Button size="sm" onClick={onOpenInvite}><Plus className="size-3.5" />Invite members</Button> : null}</div>
      <section className="mt-2 overflow-hidden rounded-xl border border-border/70 bg-card">
        {members.map((member) => <div key={member.actorId} className="flex min-h-14 items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-b-0">
          <PersonMark name={member.displayName} />
          <div className="min-w-0 flex-1"><p className="truncate text-sm">{member.displayName}{member.actorId === currentActorId ? " (you)" : ""}</p><p className="truncate text-xs text-muted-foreground">{member.emailAddress ?? member.actorId}</p></div>
          {admin ? <>
            <select aria-label={`Role for ${member.displayName}`} value={member.role} disabled={!onMemberRoleChange} onChange={(event) => onMemberRoleChange?.(member.actorId, event.target.value as OrganizationManagementRole)} className="h-7 rounded-md border border-transparent bg-transparent px-2 text-xs disabled:cursor-not-allowed disabled:opacity-100"><option value="org:admin">Admin</option><option value="org:member">Member</option></select>
            <button type="button" aria-label={`Actions for ${member.displayName}`} disabled={!onOpenMemberActions} onClick={() => onOpenMemberActions?.(member.actorId)} className="flex size-7 items-center justify-center rounded-md text-muted-foreground disabled:opacity-100"><MoreHorizontal className="size-3.5" /></button>
          </> : <span className="text-xs text-muted-foreground">{roleLabel(member.role)}</span>}
        </div>)}
        {admin ? invitations.map((invitation) => <div key={invitation.invitationId} className="flex min-h-14 items-center gap-3 border-t border-border/60 px-4 py-2.5">
          <PersonMark name={invitation.emailAddress} /><div className="min-w-0 flex-1"><p className="truncate text-sm text-muted-foreground">{invitation.emailAddress}</p><p className="text-xs text-muted-foreground">Invited · {roleLabel(invitation.role)}</p></div>
          <button type="button" aria-label={`Resend invitation to ${invitation.emailAddress}`} disabled={!onResendInvitation} onClick={() => onResendInvitation?.(invitation.invitationId)} className="rounded-md px-2 py-1 text-xs disabled:opacity-100">Resend</button>
          <button type="button" aria-label={`Revoke invitation for ${invitation.emailAddress}`} disabled={!onRevokeInvitation} onClick={() => onRevokeInvitation?.(invitation.invitationId)} className="rounded-md px-2 py-1 text-xs disabled:opacity-100">Revoke</button>
        </div>) : null}
      </section>

      {admin && lastAdmin ? <section className="mt-6 rounded-xl bg-muted/60 px-4 py-3"><p className="text-xs text-muted-foreground">You’re the only Admin. Make someone else an Admin before you leave.</p><div className="mt-2 flex items-center gap-2"><Button size="sm" variant="outline" disabled={!onMakeSomeoneAdmin} onClick={onMakeSomeoneAdmin}>Make someone Admin</Button><Button size="sm" variant="outline" disabled>Leave organization</Button><Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>Delete organization</Button></div></section>
        : admin ? <div className="mt-6 flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => setLeaveOpen(true)}>Leave organization</Button><Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>Delete organization</Button></div>
          : <div className="mt-6"><Button size="sm" variant="outline" onClick={() => setLeaveOpen(true)}>Leave {organization.name}</Button></div>}

      <LeaveOrganizationDialog organization={organization} open={leaveOpen} onOpenChange={setLeaveOpen} onConfirm={onLeave} busy={busy} />
      <DeleteOrganizationDialog organization={organization} open={deleteOpen} onOpenChange={setDeleteOpen} onConfirm={onDelete} busy={busy} />
    </div>
  );
}

export default function OrganizationSection() {
  const { userId } = useAuth();
  const { organization: clerkOrganization } = useOrganization();
  const { setActive } = useOrganizationList();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [makeAdminOpen, setMakeAdminOpen] = useState(false);
  const [memberActionActorId, setMemberActionActorId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const logoInput = useRef<HTMLInputElement>(null);
  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  const listing = useShellOrganizations(refreshKey);
  const organization = listing.state === "loaded" ? listing.organizations.find((candidate) => candidate.organizationId === clerkOrganization?.id) ?? null : null;
  const directory = useShellOrganizationDirectory(organization?.organizationId ?? null, organization?.role === "org:admin", refreshKey);
  const actions = useShellOrganizationActions(organization?.organizationId ?? null, refresh);

  if (listing.state === "loading" || (organization && directory.state === "loading")) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading organization…</p>;
  if (listing.state === "failed" || directory.state === "failed") return <p role="alert" className="p-6 text-sm text-destructive">Organization settings are unavailable. Try again.</p>;
  if (!organization) return <div className="mx-auto max-w-2xl space-y-6 p-6"><div><h2 className="text-lg font-semibold">Organization</h2><p className="mt-1 text-sm text-muted-foreground">Select an organization to see its details and members.</p></div><div className="rounded-xl border border-border/70 p-6 text-center text-sm text-muted-foreground">Select an organization from the title bar to manage it here.</div></div>;

  const selectedMember = directory.members.find((member) => member.actorId === memberActionActorId) ?? null;
  const leave = async () => {
    if (!userId) return;
    if (await actions.run((client) => client.removeMember(userId))) await setActive?.({ organization: null });
  };
  const removeSelectedMember = async () => {
    if (!selectedMember) return;
    if (await actions.run((client) => client.removeMember(selectedMember.actorId))) setMemberActionActorId(null);
  };
  const deleteOrganization = async () => {
    if (await actions.run((client) => client.deleteOrganization())) await setActive?.({ organization: null });
  };

  return <>
    {actions.error ? <div role="alert" className="mx-auto mt-6 max-w-2xl rounded-lg border border-destructive/50 px-3 py-2 text-sm text-destructive">{actions.error}</div> : null}
    <OrganizationSectionView
      organization={organization}
      currentActorId={userId ?? null}
      members={directory.members}
      invitations={directory.invitations}
      onOpenInvite={() => setInviteOpen(true)}
      onChangeLogo={() => logoInput.current?.click()}
      onRename={() => setRenameOpen(true)}
      onMemberRoleChange={(actorId, role) => { void actions.run((client) => client.updateRole(actorId, role)); }}
      onOpenMemberActions={setMemberActionActorId}
      onResendInvitation={(invitationId) => { void actions.run((client) => client.resendInvitation(invitationId)); }}
      onRevokeInvitation={(invitationId) => { void actions.run((client) => client.revokeInvitation(invitationId)); }}
      onMakeSomeoneAdmin={() => setMakeAdminOpen(true)}
      onLeave={leave}
      onDelete={deleteOrganization}
      busy={actions.busy}
    />
    <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" aria-label="Organization logo file" onChange={(event) => {
      const file = event.target.files?.[0];
      if (file) void actions.run((client) => client.updateLogo(file, file.name));
      event.target.value = "";
    }} />
    <InviteMembersDialog organization={organization} open={inviteOpen} busy={actions.busy} onOpenChange={setInviteOpen} onSubmit={async (input) => {
      if (await actions.run((client) => client.invite(input.emailAddresses, input.role))) setInviteOpen(false);
    }} />
    <RenameOrganizationDialog organization={organization} open={renameOpen} busy={actions.busy} onOpenChange={setRenameOpen} onSubmit={async (name) => {
      if (await actions.run((client) => client.rename(name))) setRenameOpen(false);
    }} />
    <RemoveMemberDialog member={selectedMember} open={selectedMember !== null} busy={actions.busy} onOpenChange={(open) => { if (!open) setMemberActionActorId(null); }} onConfirm={removeSelectedMember} />
    <MakeAdminDialog members={directory.members} open={makeAdminOpen} busy={actions.busy} onOpenChange={setMakeAdminOpen} onConfirm={async (actorId) => {
      if (await actions.run((client) => client.updateRole(actorId, "org:admin"))) setMakeAdminOpen(false);
    }} />
  </>;
}

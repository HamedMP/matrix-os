import type {
  OrganizationManagementInvitation,
  OrganizationManagementMember,
  OrganizationManagementRole,
  OrganizationManagementSummary,
} from "@matrix-os/contracts";
import { MoreHorizontal, Plus } from "@renderer/lib/hugeicons";
import { useCallback, useRef, useState } from "react";
import { Button } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useDesktopOrganizations } from "../collaboration/useDesktopOrganizations";
import { SettingsSectionHeader } from "../settings/sections/section-kit";
import {
  DeleteOrganizationDialog,
  InviteMembersDialog,
  LeaveOrganizationDialog,
  MakeAdminDialog,
  RemoveMemberDialog,
  RenameOrganizationDialog,
} from "./OrganizationDialogs";
import { OrganizationMark, initialsForOrganization } from "./OrganizationMark";
import { useDesktopOrganizationDirectory } from "./useDesktopOrganizationDirectory";
import { useDesktopOrganizationActions } from "./useDesktopOrganizationActions";

function roleLabel(role: OrganizationManagementMember["role"]): string {
  return role === "org:admin" ? "Admin" : "Member";
}

function invitationAgeLabel(createdAt: string): string {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return "recently";
  const days = Math.max(0, Math.floor((Date.now() - created) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function PersonMark({ name }: { name: string }) {
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs" style={{ background: "var(--bg-hover)", color: "var(--text-tertiary)" }}>{initialsForOrganization(name)}</span>;
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
  const completeMemberList = members.length >= organization.memberCount;
  const administrators = members.filter((member) => member.role === "org:admin");
  const lastAdmin = admin && completeMemberList && administrators.length === 1 && administrators[0]?.actorId === currentActorId;
  const description = admin ? `Details and members of ${organization.name}.` : `You’re a member of ${organization.name}.`;

  return (
    <>
      <SettingsSectionHeader title="Organization" description={description} />
      <section className="flex min-h-[90px] items-center justify-between gap-4 rounded-xl border p-5" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
        <div className="flex min-w-0 items-center gap-3">
          <OrganizationMark name={organization.name} size={48} />
          <div className="min-w-0">
            <h4 className="truncate text-[15px] font-semibold" style={{ color: "var(--text-primary)" }}>{organization.name}</h4>
            <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>{organization.memberCount} {organization.memberCount === 1 ? "member" : "members"}</p>
          </div>
        </div>
        {admin ? <div className="flex items-center gap-2">
          <Button variant="ghost" className="border" style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }} disabled={!onChangeLogo} onClick={onChangeLogo}>Change logo</Button>
          <Button variant="ghost" className="border" style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }} disabled={!onRename} onClick={onRename}>Rename</Button>
        </div> : null}
      </section>

      <div className="mt-6 flex items-center justify-between">
        <h4 className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Members</h4>
        {admin ? <Button variant="primary" style={{ background: "#171717", color: "#fff" }} onClick={onOpenInvite}><Plus aria-hidden="true" size={14} />Invite members</Button> : null}
      </div>
      <section className="mt-3 overflow-hidden rounded-xl border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
        {members.map((member) => (
          <div key={member.actorId} className="flex min-h-[61px] items-center gap-3 border-b px-4 py-2.5 last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
            <PersonMark name={member.displayName} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" style={{ color: "var(--text-primary)" }}>{member.displayName}{member.actorId === currentActorId ? " (you)" : ""}</p>
              <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{member.emailAddress ?? member.actorId}</p>
            </div>
            {admin ? <>
              <select
                aria-label={`Role for ${member.displayName}`}
                value={member.role}
                disabled={!onMemberRoleChange}
                onChange={(event) => onMemberRoleChange?.(member.actorId, event.target.value as OrganizationManagementRole)}
                className="h-7 rounded-md border bg-transparent px-2 text-xs disabled:cursor-not-allowed disabled:opacity-100"
                style={{ borderColor: "transparent", color: "var(--text-primary)" }}
              >
                <option value="org:admin">Admin</option>
                <option value="org:member">Member</option>
              </select>
              <button type="button" aria-label={`Actions for ${member.displayName}`} disabled={!onOpenMemberActions} onClick={() => onOpenMemberActions?.(member.actorId)} className="flex size-7 items-center justify-center rounded-md disabled:opacity-100" style={{ color: "var(--text-tertiary)" }}><MoreHorizontal aria-hidden="true" size={14} /></button>
            </> : <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{roleLabel(member.role)}</span>}
          </div>
        ))}
        {admin ? invitations.map((invitation) => (
          <div key={invitation.invitationId} className="flex min-h-[61px] items-center gap-3 border-t px-4 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
            <PersonMark name={invitation.emailAddress} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" style={{ color: "var(--text-secondary)" }}>{invitation.emailAddress}</p>
              <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>Invited · {invitationAgeLabel(invitation.createdAt)}</p>
            </div>
            <button type="button" aria-label={`Resend invitation to ${invitation.emailAddress}`} disabled={!onResendInvitation} onClick={() => onResendInvitation?.(invitation.invitationId)} className="rounded-md px-2 py-1 text-xs disabled:opacity-100" style={{ color: "var(--text-primary)" }}>Resend</button>
            <button type="button" aria-label={`Revoke invitation for ${invitation.emailAddress}`} disabled={!onRevokeInvitation} onClick={() => onRevokeInvitation?.(invitation.invitationId)} className="rounded-md px-2 py-1 text-xs disabled:opacity-100" style={{ color: "var(--text-primary)" }}>Revoke</button>
          </div>
        )) : null}
      </section>

      {admin && lastAdmin ? <section className="mt-8 rounded-xl px-4 py-3" style={{ background: "var(--bg-hover)" }}>
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>You’re the only Admin. Make someone else an Admin before you leave.</p>
        <div className="mt-2 flex items-center gap-2">
          <Button variant="ghost" className="border" style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }} disabled={!onMakeSomeoneAdmin} onClick={onMakeSomeoneAdmin}>Make someone Admin</Button>
          <Button variant="ghost" className="border" style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }} disabled>Leave organization</Button>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete organization</Button>
        </div>
      </section> : admin ? <div className="mt-8 flex items-center gap-2">
        <Button variant="ghost" className="border" style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }} onClick={() => setLeaveOpen(true)}>Leave organization</Button>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete organization</Button>
      </div> : <div className="mt-8">
        <Button variant="ghost" className="border" style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }} onClick={() => setLeaveOpen(true)}>Leave {organization.name}</Button>
      </div>}

      <LeaveOrganizationDialog organization={organization} open={leaveOpen} busy={busy} onClose={() => setLeaveOpen(false)} onConfirm={onLeave} />
      <DeleteOrganizationDialog organization={organization} open={deleteOpen} busy={busy} onClose={() => setDeleteOpen(false)} onConfirm={onDelete} />
    </>
  );
}

export default function OrganizationSection() {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [makeAdminOpen, setMakeAdminOpen] = useState(false);
  const [memberActionActorId, setMemberActionActorId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const logoInput = useRef<HTMLInputElement>(null);
  const currentActorId = useConnection((state) => state.userId);
  const organizationId = useConnection((state) => state.organizationId);
  const selectOrganization = useConnection((state) => state.selectOrganization);
  const listing = useDesktopOrganizations(refreshKey);
  const organization = listing.state === "loaded" ? listing.organizations.find((candidate) => candidate.organizationId === organizationId) ?? null : null;
  const directory = useDesktopOrganizationDirectory(organization?.organizationId ?? null, organization?.role === "org:admin", refreshKey);
  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  const actions = useDesktopOrganizationActions(organization?.organizationId ?? null, refresh);

  if (listing.state === "loading" || (organization && directory.state === "loading")) return <p role="status" className="text-sm" style={{ color: "var(--text-tertiary)" }}>Loading organization…</p>;
  if (listing.state === "failed" || directory.state === "failed") return <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>Organization settings are unavailable. Try again.</p>;
  if (!organization) return <><SettingsSectionHeader title="Organization" description="Select an organization to see its details and members." /><div className="rounded-xl border p-6 text-center" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>Select an organization from the title bar to manage it here.</div></>;
  const selectedMember = directory.members.find((member) => member.actorId === memberActionActorId) ?? null;
  const leave = async () => {
    if (!currentActorId) return;
    if (await actions.run((client) => client.removeMember(currentActorId))) selectOrganization(null);
  };
  const removeSelectedMember = async () => {
    if (!selectedMember) return;
    if (await actions.run((client) => client.removeMember(selectedMember.actorId))) setMemberActionActorId(null);
  };
  const deleteOrganization = async () => {
    if (await actions.run((client) => client.deleteOrganization())) selectOrganization(null);
  };
  return <>
    <div className="w-full">
      {actions.error ? <div role="alert" className="mb-4 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{actions.error}</div> : null}
      <OrganizationSectionView
        organization={organization}
        currentActorId={currentActorId}
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
      <input
        ref={logoInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        aria-label="Organization logo file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void actions.run((client) => client.updateLogo(file, file.name));
          event.target.value = "";
        }}
      />
    </div>
    <InviteMembersDialog organization={organization} open={inviteOpen} busy={actions.busy} onClose={() => setInviteOpen(false)} onSubmit={async (input) => {
      if (await actions.run((client) => client.invite(input.emailAddresses, input.role))) setInviteOpen(false);
    }} />
    <RenameOrganizationDialog organization={organization} open={renameOpen} busy={actions.busy} onClose={() => setRenameOpen(false)} onSubmit={async (name) => {
      if (await actions.run((client) => client.rename(name))) setRenameOpen(false);
    }} />
    <RemoveMemberDialog member={selectedMember} open={selectedMember !== null} busy={actions.busy} onClose={() => setMemberActionActorId(null)} onConfirm={removeSelectedMember} />
    <MakeAdminDialog members={directory.members} open={makeAdminOpen} busy={actions.busy} onClose={() => setMakeAdminOpen(false)} onConfirm={async (actorId) => {
      if (await actions.run((client) => client.updateRole(actorId, "org:admin"))) setMakeAdminOpen(false);
    }} />
  </>;
}

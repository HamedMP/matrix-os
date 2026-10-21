"use client";

import { useState, type KeyboardEvent } from "react";
import type { OrganizationManagementMember, OrganizationManagementRole, OrganizationManagementSummary } from "@matrix-os/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { X } from "@/lib/hugeicons";

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

export function InviteMembersDialog({ organization, open, onOpenChange, onSubmit, busy = false }: {
  organization: OrganizationManagementSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (input: { emailAddresses: string[]; role: OrganizationManagementRole }) => void | Promise<void>;
  busy?: boolean;
}) {
  const [emailAddresses, setEmailAddresses] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<OrganizationManagementRole>("org:member");
  const addDraft = () => {
    const emailAddress = draft.trim().replace(/,$/, "").toLowerCase();
    if (!EMAIL_PATTERN.test(emailAddress) || emailAddresses.includes(emailAddress)) return;
    setEmailAddresses((current) => [...current, emailAddress].slice(0, 20));
    setDraft("");
  };
  const onEmailKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== ",") return;
    event.preventDefault();
    addDraft();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader><DialogTitle>Invite to {organization.name}</DialogTitle><DialogDescription className="sr-only">Invite people by email and choose their organization role.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          const pending = draft.trim().replace(/,$/, "").toLowerCase();
          const addresses = EMAIL_PATTERN.test(pending) && !emailAddresses.includes(pending) ? [...emailAddresses, pending] : emailAddresses;
          if (addresses.length > 0 && onSubmit) void onSubmit({ emailAddresses: addresses.slice(0, 10), role });
        }}>
          <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
            Emails
            <span className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
              {emailAddresses.map((emailAddress) => <span key={emailAddress} className="inline-flex h-6 items-center gap-1 rounded bg-muted px-2 text-xs font-normal text-foreground">
                {emailAddress}
                <button type="button" aria-label={`Remove ${emailAddress}`} onClick={() => setEmailAddresses((current) => current.filter((candidate) => candidate !== emailAddress))} className="-mr-1 rounded p-0.5 hover:bg-accent"><X className="size-3" /></button>
              </span>)}
              <input aria-label="Emails" type="email" autoComplete="email" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onEmailKeyDown} onBlur={addDraft} placeholder={emailAddresses.length > 0 ? "Add email…" : "name@company.com"} className="h-6 min-w-32 flex-1 bg-transparent px-1 text-sm font-normal text-foreground outline-none" />
            </span>
          </label>
          <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
            Role
            <select aria-label="Role" value={role} onChange={(event) => setRole(event.target.value as OrganizationManagementRole)} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm font-normal text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <option value="org:member">Member</option>
              <option value="org:admin">Admin</option>
            </select>
            <span className="block font-normal">Admins can also invite and remove people.</span>
          </label>
          {!onSubmit ? <p role="note" className="text-xs text-muted-foreground">Sending invitations will be enabled with the organization actions service.</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={(emailAddresses.length === 0 && !EMAIL_PATTERN.test(draft.trim())) || !onSubmit || busy}>{busy ? "Sending…" : "Send invites"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveOrganizationDialog({ organization, open, onOpenChange, onConfirm, busy = false }: {
  organization: OrganizationManagementSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm?: () => void | Promise<void>;
  busy?: boolean;
}) {
  const title = `Leave ${organization.name}?`;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent role="alertdialog" aria-label={title} className="sm:max-w-[420px]">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription asChild><ul className="space-y-2 text-left">
        <li>· You’ll lose access to everything shared with you in {organization.name}.</li>
        <li>· What you shared with {organization.name} stops being shared. It stays on your computer.</li>
        <li>· An admin has to invite you to come back.</li>
      </ul></DialogDescription></DialogHeader>
      {!onConfirm ? <p role="note" className="text-xs text-muted-foreground">Leaving will be enabled with the organization actions service.</p> : null}
      <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" variant="destructive" disabled={!onConfirm || busy} onClick={() => { void onConfirm?.(); }}>{busy ? "Leaving…" : "Leave"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function DeleteOrganizationDialog({ organization, open, onOpenChange, onConfirm, busy = false }: {
  organization: OrganizationManagementSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm?: () => void | Promise<void>;
  busy?: boolean;
}) {
  const title = `Delete ${organization.name}?`;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent role="alertdialog" aria-label={title} className="sm:max-w-[420px]">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>This permanently deletes the organization and removes access for every member.</DialogDescription></DialogHeader>
      {!onConfirm ? <p role="note" className="text-xs text-muted-foreground">Deletion will be enabled with the organization actions service.</p> : null}
      <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" variant="destructive" disabled={!onConfirm || busy} onClick={() => { void onConfirm?.(); }}>{busy ? "Deleting…" : "Delete organization"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function RenameOrganizationDialog({ organization, open, onOpenChange, onSubmit, busy = false }: {
  organization: OrganizationManagementSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const [name, setName] = useState(organization.name);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-[420px]">
      <DialogHeader><DialogTitle>Rename organization</DialogTitle><DialogDescription>Choose the name shown to everyone in this organization.</DialogDescription></DialogHeader>
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void onSubmit(name.trim()); }}>
        <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
          Organization name
          <input aria-label="Organization name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm font-normal text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
        </label>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={!name.trim() || name.trim() === organization.name || busy}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function RemoveMemberDialog({ member, open, onOpenChange, onConfirm, busy = false }: {
  member: OrganizationManagementMember | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
}) {
  if (!member) return null;
  const title = `Remove ${member.displayName}?`;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent role="alertdialog" aria-label={title} className="sm:max-w-[420px]">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>They’ll lose access to everything shared with the organization. An Admin can invite them again later.</DialogDescription></DialogHeader>
      <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => { void onConfirm(); }}>{busy ? "Removing…" : "Remove member"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function MakeAdminDialog({ members, open, onOpenChange, onConfirm, busy = false }: {
  members: readonly OrganizationManagementMember[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (actorId: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const candidates = members.filter((member) => member.role === "org:member");
  const [actorId, setActorId] = useState(candidates[0]?.actorId ?? "");
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-[420px]">
      <DialogHeader><DialogTitle>Make someone Admin</DialogTitle><DialogDescription>Choose another member to manage the organization.</DialogDescription></DialogHeader>
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); if (actorId) void onConfirm(actorId); }}>
        <select aria-label="Member to make Admin" value={actorId} onChange={(event) => setActorId(event.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground shadow-xs">
          {candidates.map((member) => <option key={member.actorId} value={member.actorId}>{member.displayName}</option>)}
        </select>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={!actorId || busy}>{busy ? "Updating…" : "Make Admin"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

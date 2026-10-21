import { useState, type KeyboardEvent } from "react";
import type { OrganizationManagementMember, OrganizationManagementRole, OrganizationManagementSummary } from "@matrix-os/contracts";
import { X } from "@renderer/lib/hugeicons";
import { Button, Dialog } from "../../design/primitives";

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

export function InviteMembersDialog({ organization, open, onClose, onSubmit, busy = false }: {
  organization: OrganizationManagementSummary;
  open: boolean;
  onClose: () => void;
  onSubmit?: (input: { emailAddresses: string[]; role: OrganizationManagementRole }) => void | Promise<void>;
  busy?: boolean;
}) {
  const [emailAddresses, setEmailAddresses] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<OrganizationManagementRole>("org:member");

  const addDraft = () => {
    const emailAddress = draft.trim().replace(/,$/, "").toLowerCase();
    if (!EMAIL_PATTERN.test(emailAddress) || emailAddresses.includes(emailAddress)) return;
    setEmailAddresses((current) => [...current, emailAddress].slice(0, 10));
    setDraft("");
  };
  const onEmailKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== ",") return;
    event.preventDefault();
    addDraft();
  };

  return (
    <Dialog open={open} onClose={onClose} title={`Invite to ${organization.name}`} width={440} placement="top" top="26.6vh">
      <div className="flex items-center justify-between px-5 pb-3 pt-4">
        <h2 className="text-[15px] font-semibold" style={{ color: "var(--text-primary)" }}>Invite to {organization.name}</h2>
        <button type="button" aria-label="Close invitation dialog" onClick={onClose} className="flex size-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" style={{ color: "var(--text-tertiary)" }}>
          <X aria-hidden="true" size={15} />
        </button>
      </div>
      <form
        className="space-y-4 px-5 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          const pending = draft.trim().replace(/,$/, "").toLowerCase();
          const addresses = EMAIL_PATTERN.test(pending) && !emailAddresses.includes(pending) ? [...emailAddresses, pending] : emailAddresses;
          if (addresses.length > 0 && onSubmit) void onSubmit({ emailAddresses: addresses.slice(0, 10), role });
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Emails</span>
          <span className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border px-2 py-1" style={{ borderColor: "var(--border-default)", background: "var(--bg-surface)" }}>
            {emailAddresses.map((emailAddress) => (
              <span key={emailAddress} className="inline-flex h-6 items-center gap-1 rounded px-2 text-xs" style={{ background: "var(--bg-hover)", color: "var(--text-primary)" }}>
                {emailAddress}
                <button type="button" aria-label={`Remove ${emailAddress}`} onClick={() => setEmailAddresses((current) => current.filter((candidate) => candidate !== emailAddress))} className="-mr-1 rounded p-0.5 hover:bg-[var(--bg-selected)]">
                  <X aria-hidden="true" size={11} />
                </button>
              </span>
            ))}
            <input
              aria-label="Emails"
              type="email"
              autoComplete="email"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onEmailKeyDown}
              onBlur={addDraft}
              placeholder={emailAddresses.length > 0 ? "Add email…" : "name@company.com"}
              className="h-6 min-w-20 flex-1 bg-transparent px-1 text-sm outline-none"
              style={{ color: "var(--text-primary)" }}
            />
          </span>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Role</span>
          <select aria-label="Role" value={role} onChange={(event) => setRole(event.target.value as OrganizationManagementRole)} className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none" style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}>
            <option value="org:member">Member</option>
            <option value="org:admin">Admin</option>
          </select>
          <span className="mt-1.5 block text-xs" style={{ color: "var(--text-tertiary)" }}>Admins can also invite and remove people.</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" style={{ background: "#171717", color: "#fff" }} disabled={(emailAddresses.length === 0 && !EMAIL_PATTERN.test(draft.trim())) || !onSubmit || busy}>{busy ? "Sending…" : "Send invites"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function LeaveOrganizationDialog({ organization, open, onClose, onConfirm, busy = false }: {
  organization: OrganizationManagementSummary;
  open: boolean;
  onClose: () => void;
  onConfirm?: () => void | Promise<void>;
  busy?: boolean;
}) {
  const title = `Leave ${organization.name}?`;
  return (
    <Dialog open={open} onClose={onClose} title={title} role="alertdialog" width={420} placement="top" top="28.5vh">
      <div className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
          <button type="button" aria-label="Close leave dialog" onClick={onClose} className="flex size-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" style={{ color: "var(--text-tertiary)" }}><X aria-hidden="true" size={15} /></button>
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-3 text-sm leading-5" style={{ color: "var(--text-secondary)" }}>
          <li>You’ll lose access to everything shared with you in {organization.name}.</li>
          <li>What you shared with {organization.name} stops being shared. It stays on your computer.</li>
          <li>An admin has to invite you to come back.</li>
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!onConfirm || busy} onClick={() => { void onConfirm?.(); }}>{busy ? "Leaving…" : "Leave"}</Button>
        </div>
      </div>
    </Dialog>
  );
}

export function DeleteOrganizationDialog({ organization, open, onClose, onConfirm, busy = false }: {
  organization: OrganizationManagementSummary;
  open: boolean;
  onClose: () => void;
  onConfirm?: () => void | Promise<void>;
  busy?: boolean;
}) {
  const title = `Delete ${organization.name}?`;
  return (
    <Dialog open={open} onClose={onClose} title={title} role="alertdialog" width={420} placement="center">
      <div className="p-5">
        <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
        <p className="mt-2 text-sm leading-5" style={{ color: "var(--text-secondary)" }}>This permanently deletes the organization and removes access for every member.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!onConfirm || busy} onClick={() => { void onConfirm?.(); }}>{busy ? "Deleting…" : "Delete organization"}</Button>
        </div>
      </div>
    </Dialog>
  );
}

export function RenameOrganizationDialog({ organization, open, onClose, onSubmit, busy = false }: {
  organization: OrganizationManagementSummary;
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const [name, setName] = useState(organization.name);
  return (
    <Dialog open={open} onClose={onClose} title="Rename organization" width={420} placement="center">
      <form className="p-5" onSubmit={(event) => { event.preventDefault(); void onSubmit(name.trim()); }}>
        <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Rename organization</h2>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Organization name</span>
          <input aria-label="Organization name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }} />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!name.trim() || name.trim() === organization.name || busy}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RemoveMemberDialog({ member, open, onClose, onConfirm, busy = false }: {
  member: OrganizationManagementMember | null;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
}) {
  if (!member) return null;
  return (
    <Dialog open={open} onClose={onClose} title={`Remove ${member.displayName}?`} role="alertdialog" width={420} placement="center">
      <div className="p-5">
        <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Remove {member.displayName}?</h2>
        <p className="mt-2 text-sm leading-5" style={{ color: "var(--text-secondary)" }}>They’ll lose access to everything shared with the organization. An Admin can invite them again later.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => { void onConfirm(); }}>{busy ? "Removing…" : "Remove member"}</Button>
        </div>
      </div>
    </Dialog>
  );
}

export function MakeAdminDialog({ members, open, onClose, onConfirm, busy = false }: {
  members: readonly OrganizationManagementMember[];
  open: boolean;
  onClose: () => void;
  onConfirm: (actorId: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const candidates = members.filter((member) => member.role === "org:member");
  const [actorId, setActorId] = useState(candidates[0]?.actorId ?? "");
  return (
    <Dialog open={open} onClose={onClose} title="Make someone Admin" width={420} placement="center">
      <form className="p-5" onSubmit={(event) => { event.preventDefault(); if (actorId) void onConfirm(actorId); }}>
        <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Make someone Admin</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>Choose another member to manage the organization.</p>
        <select aria-label="Member to make Admin" value={actorId} onChange={(event) => setActorId(event.target.value)} className="mt-4 h-9 w-full rounded-md border bg-transparent px-3 text-sm" style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}>
          {candidates.map((member) => <option key={member.actorId} value={member.actorId}>{member.displayName}</option>)}
        </select>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!actorId || busy}>{busy ? "Updating…" : "Make Admin"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

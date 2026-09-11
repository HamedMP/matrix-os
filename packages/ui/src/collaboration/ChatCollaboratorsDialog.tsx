import {
  CollaborationActorIdSchema,
  CollaborationMemberSchema,
  CollaborationScopeSchema,
  type CollaborationTerminalFrame,
} from "@matrix-os/contracts";
import { useRef, useState } from "react";
import type { z } from "zod/v4";
import { Dialog } from "../Dialog.js";

type Scope = z.infer<typeof CollaborationScopeSchema>;
type Member = z.infer<typeof CollaborationMemberSchema>;

export interface CollaborationApi {
  baseUrl: string;
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch?(path: string, body: unknown): Promise<unknown>;
  delete(path: string, body?: unknown): Promise<unknown>;
  subscribe?(scopeId: string, onEvent: () => void | Promise<void>, onUnavailable: () => void): () => void;
  subscribeTerminal?(scopeId: string, handlers: {
    onReady(frame: Extract<CollaborationTerminalFrame, { type: "terminal.ready" }>): void;
    onOutput(frame: Extract<CollaborationTerminalFrame, { type: "terminal.output" }>): void;
    onState(frame: Extract<CollaborationTerminalFrame, { type: "terminal.state" }>): void;
    onRefreshRequired(): void | Promise<void>;
    onUnavailable(): void;
  }): () => void;
}

const buttonClass = "rounded-lg border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

export function ChatCollaboratorsDialog({ api, scope, members, onRefresh, onClose }: {
  api: CollaborationApi;
  scope: Scope;
  members: Member[];
  onRefresh: () => Promise<{ scope: Scope; members: Member[] }>;
  onClose: () => void;
}) {
  const resourceLabel = scope.kind === "chat" ? "Chat" : scope.kind === "terminal" ? "terminal" : "project";
  const currentScope = useRef(scope);
  const [currentMembers, setCurrentMembers] = useState(members);
  const [targetActorId, setTargetActorId] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  const beginAction = () => {
    setPending(true);
    setError("");
  };
  const failAction = (failure: unknown) => {
    console.warn("[chat-collaboration] member action failed", failure instanceof Error ? failure.name : "UnknownError");
    setError("Collaboration could not be updated. Refresh and try again.");
  };
  const refresh = async () => {
    const next = await onRefresh();
    currentScope.current = next.scope;
    setCurrentMembers(next.members);
  };
  const invite = async () => {
    beginAction();
    try {
      const actorId = CollaborationActorIdSchema.parse(targetActorId.trim());
      await api.post(`/api/collaboration/scopes/${currentScope.current.id}/invitations`, {
        targetActorId: actorId,
        role,
        clientRequestId: crypto.randomUUID(),
        expectedRevision: currentScope.current.revision,
      });
      await refresh();
      setTargetActorId("");
      setFeedback("Invitation sent. Access begins only after acceptance.");
    } catch (failure: unknown) {
      failAction(failure);
    } finally {
      setPending(false);
    }
  };
  const changeRole = async (member: Member, nextRole: "editor" | "viewer") => {
    beginAction();
    try {
      if (!api.patch) throw new Error("Unsupported collaboration client");
      await api.patch(`/api/collaboration/scopes/${currentScope.current.id}/members/${member.actor.actorId}`, {
        role: nextRole,
        clientRequestId: crypto.randomUUID(),
        expectedRevision: currentScope.current.revision,
        expectedMemberRevision: member.revision,
      });
      await refresh();
      setFeedback(`${member.actor.displayName} is now a ${nextRole}.`);
    } catch (failure: unknown) {
      failAction(failure);
    } finally {
      setPending(false);
    }
  };
  const revoke = async (member: Member) => {
    beginAction();
    try {
      const base = `/api/collaboration/scopes/${currentScope.current.id}`;
      const path = member.status === "pending" && member.invitationId
        ? `${base}/invitations/${member.invitationId}`
        : `${base}/members/${member.actor.actorId}`;
      await api.delete(path, {
        clientRequestId: crypto.randomUUID(),
        expectedRevision: currentScope.current.revision,
        expectedMemberRevision: member.revision,
      });
      await refresh();
      setFeedback(member.status === "pending" ? "Invitation revoked." : "Collaborator removed.");
    } catch (failure: unknown) {
      failAction(failure);
    } finally {
      setPending(false);
    }
  };
  return <Dialog open onClose={() => { if (!pending) onClose(); }} aria-label="Invite collaborators"
    className="ph-no-capture flex max-h-[85vh] w-[min(92vw,640px)] flex-col gap-5 overflow-y-auto rounded-2xl border p-6"
    style={{ background: "var(--bg-surface, var(--matrix-card, #FCFCF8))", color: "var(--text-primary, var(--matrix-card-fg, #32352E))",
      borderColor: "var(--border-default, var(--matrix-border, #D8D6C7))" }}>
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold">Invite collaborators</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Invite access applies only to this ongoing {resourceLabel}. It does not grant access to its project, sibling Chats or terminals, files, or apps.
        </p>
      </div>
      <button type="button" className={buttonClass} disabled={pending} onClick={onClose}>Close</button>
    </div>
    <section aria-labelledby="invite-person-heading" className="rounded-xl border p-4">
      <h3 id="invite-person-heading" className="font-medium">Invite a person</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_9rem_auto]">
        <label className="grid gap-1 text-sm">Matrix user ID
          <input value={targetActorId} disabled={pending} onChange={(event) => setTargetActorId(event.target.value)}
            placeholder="user_…" className="min-w-0 rounded-lg border bg-transparent px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm">Role
          <select value={role} disabled={pending} onChange={(event) => setRole(event.target.value as "editor" | "viewer")}
            className="rounded-lg border bg-transparent px-3 py-2">
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
        </label>
        <button type="button" className={`${buttonClass} self-end`} disabled={pending || !targetActorId.trim()} onClick={() => void invite()}>
          {pending ? "Sending…" : "Send invitation"}
        </button>
      </div>
      <p className="mt-3 text-xs" style={{ color: "var(--text-secondary)" }}>
        {scope.kind === "terminal"
          ? "Editors can watch and request input control. Viewers watch only. Owners may take over control."
          : "Editors can read, discuss, and request AI when shared AI is available. Viewers can read only. Owners decide AI approvals."}
      </p>
    </section>
    <section aria-labelledby="people-heading">
      <h3 id="people-heading" className="font-medium">People with access</h3>
      <div className="mt-2 grid gap-2">
        {currentMembers.length === 0 ? <div className="rounded-xl border p-5 text-center">
          <div aria-hidden className="text-xl">◇</div>
          <p className="mt-1 font-medium">No collaborators yet</p>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Invite an editor or viewer above.</p>
        </div> : currentMembers.map((member) => <div key={member.actor.actorId} className="flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{member.actor.displayName}</p>
            <p className="truncate text-xs" style={{ color: "var(--text-secondary)" }}>{member.status === "pending" ? "Invitation pending" : member.role}</p>
          </div>
          {member.role !== "owner" && member.status === "accepted" ? <select aria-label={`Role for ${member.actor.displayName}`}
            value={member.role} disabled={pending} onChange={(event) => void changeRole(member, event.target.value as "editor" | "viewer")}
            className="rounded-lg border bg-transparent px-2 py-1 text-sm">
            <option value="editor">Editor</option><option value="viewer">Viewer</option>
          </select> : null}
          {member.role !== "owner" ? <button type="button" className={buttonClass} disabled={pending}
            onClick={() => void revoke(member)}>{member.status === "pending" ? "Revoke invite" : "Remove"}</button> : null}
        </div>)}
      </div>
    </section>
    {error ? <p role="alert" className="text-sm">{error}</p> : <p role="status" className="text-sm">{feedback}</p>}
    <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
      Removing a collaborator does not revoke snapshot links. Revoking a snapshot link does not remove collaborators.
    </p>
  </Dialog>;
}

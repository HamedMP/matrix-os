import {
  CollaborationMemberSchema,
  CollaborationReadinessSchema,
  type CollaborationReadiness,
  CollaborationScopeSchema,
  type CollaborationTerminalFrame,
} from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import type { z } from "zod/v4";
import { Dialog } from "../Dialog.js";
import { AudienceGrantPicker } from "./AudienceGrantPicker.js";
import { ReadinessSummary } from "./ReadinessSummary.js";

type Scope = z.infer<typeof CollaborationScopeSchema>;
type Member = z.infer<typeof CollaborationMemberSchema>;

export interface CollaborationApi {
  baseUrl: string;
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch?(path: string, body: unknown): Promise<unknown>;
  delete(path: string, body?: unknown): Promise<unknown>;
  subscribe?(
    scopeId: string,
    onEvent: () => void | Promise<void>,
    onUnavailable: () => void,
    onConnectionChange?: (state: "connected" | "reconnecting") => void,
  ): () => void;
  subscribeTerminal?(scopeId: string, handlers: {
    onReady(frame: Extract<CollaborationTerminalFrame, { type: "terminal.ready" }>): void;
    onOutput(frame: Extract<CollaborationTerminalFrame, { type: "terminal.output" }>): void;
    onState(frame: Extract<CollaborationTerminalFrame, { type: "terminal.state" }>): void;
    onRefreshRequired(): void | Promise<void>;
    onUnavailable(): void;
    onDisconnected(): void;
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
  const resourceLabel = scope.kind === "chat" ? "Chat" : scope.kind === "terminal" ? "terminal" : scope.kind === "app" ? "app" : scope.kind;
  const [currentMembers, setCurrentMembers] = useState(members);
  const [readiness, setReadiness] = useState<CollaborationReadiness | null>(null);
  useEffect(() => {
    if (scope.kind !== "project" && scope.kind !== "chat") return;
    let active = true;
    void Promise.resolve().then(() => api.post(`/api/collaboration/scopes/${encodeURIComponent(scope.id)}/policy/preflight`, {}))
      .then((value) => {
        const parsed = CollaborationReadinessSchema.safeParse(value);
        if (active && parsed.success && parsed.data.resourceKind === scope.kind) setReadiness(parsed.data);
      })
      .catch((failure: unknown) => {
        console.warn("[collaboration-access] readiness unavailable", failure instanceof Error ? failure.name : "UnknownError");
      });
    return () => { active = false; };
  }, [api, scope.id, scope.kind]);
  const refresh = async () => {
    const next = await onRefresh();
    setCurrentMembers(next.members);
  };
  return <Dialog open onClose={onClose} aria-label="Invite collaborators"
    className="ph-no-capture flex max-h-[85vh] w-[min(92vw,640px)] flex-col gap-5 overflow-y-auto rounded-2xl border p-6"
    style={{ background: "var(--bg-surface, var(--matrix-card, #FCFCF8))", color: "var(--text-primary, var(--matrix-card-fg, #32352E))",
      borderColor: "var(--border-default, var(--matrix-border, #D8D6C7))" }}>
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold">Invite collaborators</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          {scope.kind === "project"
            ? "Sharing is limited to current members of your organization. Access applies to this whole project and its future project-owned contents; external references and unrelated resources stay outside the share."
            : scope.kind === "folder"
              ? "Access covers this folder and its contents only. Other folders, Chats and apps stay outside the share."
              : scope.kind === "file" || scope.kind === "app"
                ? `Access covers only this ${resourceLabel}. Its project, sibling files, Chats and apps stay outside the share.`
                : `Sharing is limited to current members of your organization. Access applies only to this ongoing ${resourceLabel} and does not grant access to its project, sibling Chats or terminals, files, or apps.`}
        </p>
      </div>
      <button type="button" className={buttonClass} onClick={onClose}>Close</button>
    </div>
    {readiness ? <ReadinessSummary readiness={readiness} /> : null}
    <AudienceGrantPicker api={api} scope={scope} onRefresh={refresh} />
    <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
      {scope.kind === "terminal"
        ? "Viewers watch only. Contributors may request input control. Owners may take over control."
        : scope.kind === "file" || scope.kind === "folder" || scope.kind === "app"
          ? "Viewers can read this resource. Contributors may make changes within its exact scope."
        : scope.kind === "project"
          ? "Contributors can work across shared project contents. Viewers have read-only access. Owners manage membership and AI approvals."
          : "Contributors can read, discuss, and request AI when shared AI is available. Viewers can read only. Owners decide AI approvals."}
    </p>
    <section aria-labelledby="people-heading">
      <h3 id="people-heading" className="font-medium">People with access</h3>
      <div className="mt-2 grid gap-2">
        {currentMembers.length === 0 ? <div className="rounded-xl border p-5 text-center">
          <div aria-hidden className="text-xl">◇</div>
          <p className="mt-1 font-medium">No collaborators yet</p>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Choose Viewer or Contributor above.</p>
        </div> : currentMembers.map((member) => <div key={member.actor.actorId} className="flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{member.actor.displayName}</p>
            <p className="truncate text-xs" style={{ color: "var(--text-secondary)" }}>{member.status === "pending"
              ? "Access pending" : member.role === "editor" ? "Contributor" : member.role === "viewer" ? "Viewer" : "Owner"}</p>
          </div>
        </div>)}
      </div>
    </section>
    <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
      {scope.kind === "project"
        ? "Removing a collaborator revokes the whole project membership without changing independently shared external items."
        : "Removing a collaborator does not revoke snapshot links. Revoking a snapshot link does not remove collaborators."}
    </p>
  </Dialog>;
}

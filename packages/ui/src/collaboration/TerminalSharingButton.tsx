import {
  CollaborationMemberSchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { ChatCollaboratorsDialog, type CollaborationApi } from "./ChatCollaboratorsDialog.js";

type Scope = z.infer<typeof CollaborationScopeSchema>;
type Member = z.infer<typeof CollaborationMemberSchema>;
const buttonClass = "rounded-lg border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

export function TerminalSharingButton({ api, runtimeId, organizationId, terminalId }: {
  api: CollaborationApi;
  runtimeId: string | null;
  /** The Clerk organization this share is scoped to; without one there is nothing to share with. */
  organizationId: string | null;
  terminalId: string;
}) {
  const [surface, setSurface] = useState<"collaborators" | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async (scopeId: string) => {
    const [scopeValue, membersValue] = await Promise.all([
      api.get(`/api/collaboration/scopes/${scopeId}`),
      api.get(`/api/collaboration/scopes/${scopeId}/members`),
    ]);
    const nextScope = CollaborationScopeSchema.parse(scopeValue);
    if (nextScope.kind !== "terminal" || nextScope.resourceId !== terminalId) {
      throw new Error("Terminal scope mismatch");
    }
    const nextMembers = z.object({ members: z.array(CollaborationMemberSchema).max(8) }).parse(membersValue).members;
    if (alive.current) { setScope(nextScope); setMembers(nextMembers); }
    return { scope: nextScope, members: nextMembers };
  }, [api, terminalId]);

  useEffect(() => {
    if (!runtimeId || !organizationId) return;
    let active = true;
    void api.post(`/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes/preflight`, {
      kind: "terminal", resourceId: terminalId, organizationId,
    }).then(async (value) => {
      const result = CollaborationScopePreflightResponseSchema.parse(value);
      if (active && result.existingScopeId) await refresh(result.existingScopeId);
    }).catch((failure: unknown) => {
      console.warn("[terminal-collaboration] legacy access lookup failed", failure instanceof Error ? failure.name : "UnknownError");
    });
    return () => { active = false; };
  }, [api, organizationId, refresh, runtimeId, terminalId]);

  const close = () => {
    setSurface(null);
  };
  if (!scope) return null;
  return <div className="relative inline-flex shrink-0 items-center">
    <button type="button" className={buttonClass} aria-label="Manage terminal access"
      aria-expanded={surface !== null} onClick={() => surface ? close() : setSurface("collaborators")}>
      Manage access
    </button>
    {surface === "collaborators" && scope ? <ChatCollaboratorsDialog api={api} scope={scope} members={members}
      onRefresh={() => refresh(scope.id)} onClose={close} /> : null}
  </div>;
}

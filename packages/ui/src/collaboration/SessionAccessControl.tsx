import { CollaborationMemberSchema, CollaborationProjectAccessReadinessSchema, CollaborationScopeSchema, type CollaborationProjectAccessReadiness } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { ChatCollaboratorsDialog, type CollaborationApi } from "./ChatCollaboratorsDialog.js";

type Member = z.infer<typeof CollaborationMemberSchema>;

export function SessionAccessControl({ api, scope, zIndex }: {
  api: CollaborationApi;
  scope: ReturnType<typeof CollaborationScopeSchema.parse>;
  zIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [currentScope, setCurrentScope] = useState(scope);
  const [members, setMembers] = useState<Member[]>([]);
  const [projectReadiness, setProjectReadiness] = useState<CollaborationProjectAccessReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const effectiveScope = BigInt(currentScope.revision) >= BigInt(scope.revision) ? currentScope : scope;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [scopeValue, memberValue, readinessValue] = await Promise.all([
        api.get(`/api/collaboration/scopes/${encodeURIComponent(scope.id)}`),
        api.get(`/api/collaboration/scopes/${encodeURIComponent(scope.id)}/members`),
        scope.kind === "project" && scope.lifecycle === "shared"
          ? api.get(`/api/collaboration/scopes/${encodeURIComponent(scope.id)}/project/readiness`)
          : Promise.resolve(null),
      ]);
      const currentScope = CollaborationScopeSchema.parse(scopeValue);
      const currentMembers = z.strictObject({ members: z.array(CollaborationMemberSchema).max(8) }).parse(memberValue).members;
      setCurrentScope(currentScope);
      setMembers(currentMembers);
      setProjectReadiness(readinessValue ? CollaborationProjectAccessReadinessSchema.parse(readinessValue) : null);
      return { scope: currentScope, members: currentMembers };
    } catch (failure: unknown) {
      console.warn("[collaboration-access] load failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
      throw failure;
    } finally {
      setLoading(false);
    }
  }, [api, scope.id]);
  const closeSummary = useCallback(() => {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSummary();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) closeSummary();
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [closeSummary, open]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && members.length === 0) void refresh().catch((failure: unknown) => {
      console.warn("[collaboration-access] initial load failed", failure instanceof Error ? failure.name : "UnknownError");
    });
  };
  const accepted = members.filter((member) => member.status === "accepted");
  return <div ref={containerRef} className="relative">
    <button ref={triggerRef} type="button" aria-label="Collaboration access" aria-expanded={open}
      onClick={toggle} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs hover:bg-[var(--bg-hover)]">
      <span aria-hidden className="flex -space-x-1">{accepted.length ? accepted.slice(0, 3).map((member) =>
        <span key={member.actor.actorId} className="grid size-5 place-items-center rounded-full border bg-[var(--bg-surface,var(--background))] text-[9px] font-semibold">
          {member.actor.displayName.slice(0, 1).toUpperCase()}
        </span>) : <span className="grid size-5 place-items-center rounded-full border bg-[var(--bg-surface,var(--background))] text-[9px] font-semibold">S</span>}</span>
      <span className="hidden sm:inline">{effectiveScope.membershipMode === "inherited" ? "Project access" : "Shared"}</span>
    </button>
    {open ? <section role="dialog" aria-label="Collaboration access summary" style={{ zIndex }}
      className="absolute right-0 top-full mt-2 max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border bg-background p-4 shadow-xl">
      <div className="flex items-start justify-between gap-3"><div>
        <h2 className="font-semibold">Access</h2>
        <p className="text-xs text-muted-foreground">You are {effectiveScope.role === "owner" ? "the owner" : `an ${effectiveScope.role}`}.</p>
      </div><button ref={closeRef} type="button" aria-label="Close access summary"
        className="rounded-lg px-2 py-1 text-xs hover:bg-[var(--bg-hover)]" onClick={closeSummary}>Close</button></div>
      {loading ? <p role="status" className="mt-4 text-sm">Loading people…</p> : null}
      {error ? <p role="alert" className="mt-4 text-sm">Access details are unavailable. Try again.</p> : null}
      {!loading && !error ? <ul className="mt-4 space-y-2">{accepted.map((member) => <li key={member.actor.actorId} className="flex items-center gap-3">
        <span aria-hidden className="grid size-8 place-items-center rounded-full bg-[var(--bg-hover)] text-xs font-semibold">{member.actor.displayName.slice(0, 1).toUpperCase()}</span>
        <span className="min-w-0 flex-1 truncate text-sm">{member.actor.displayName}</span><span className="text-xs capitalize text-muted-foreground">{member.role}</span>
      </li>)}</ul> : null}
      {projectReadiness ? <section aria-label="Project readiness" className="mt-4 border-t pt-3 text-xs">
        <h3 className="font-medium">Project Chat roots and Git</h3>
        {projectReadiness.chatRoots.length ? <ul className="mt-2 space-y-2">
          {projectReadiness.chatRoots.map((chat) => <li key={chat.chatId} className="rounded-lg border p-2">
            <span className="font-medium">{chat.chatId}</span>
            <p>{chat.executionRoot?.kind === "worktree"
              ? `Chat worktree ${chat.executionRoot.worktreeId}` : "Project root"}</p>
            {chat.branch ? <p>Branch: {chat.branch}</p> : null}
            {chat.dirty ? <p>Uncommitted changes</p> : null}
            {chat.readiness === "blocked" ? <p>Chat root unavailable</p> : null}
          </li>)}
        </ul> : <p className="mt-2">No project Chats yet.</p>}
        <p className="mt-2">{projectReadiness.gitSetup.identity.status === "ready"
          ? `Commits use ${projectReadiness.gitSetup.identity.label}.`
          : projectReadiness.gitSetup.identity.status === "missing" ? "Owner Git identity is missing." : "Owner Git identity is unavailable."}</p>
        <p>{projectReadiness.gitSetup.forgeCredential.status === "ready"
          ? "GitHub access is ready."
          : projectReadiness.gitSetup.forgeCredential.status === "missing" ? "GitHub access is missing." : "GitHub access is unavailable."}</p>
      </section> : null}
      {effectiveScope.capabilities.manageMembers && effectiveScope.membershipMode === "direct" ? <button type="button" className="mt-4 w-full rounded-xl border px-3 py-2 text-sm font-medium"
        onClick={() => { setOpen(false); setManageOpen(true); }}>Manage access</button> : null}
    </section> : null}
    {manageOpen ? <ChatCollaboratorsDialog api={api} scope={effectiveScope} members={members}
      onRefresh={refresh} onClose={() => { setManageOpen(false); triggerRef.current?.focus(); }} /> : null}
  </div>;
}

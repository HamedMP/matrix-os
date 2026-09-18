import { CollaborationMemberSchema, CollaborationScopeSchema } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { ChatCollaboratorsDialog, type CollaborationApi } from "./ChatCollaboratorsDialog.js";

type Member = z.infer<typeof CollaborationMemberSchema>;

export function SessionAccessControl({ api, scope }: {
  api: CollaborationApi;
  scope: ReturnType<typeof CollaborationScopeSchema.parse>;
}) {
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [scopeValue, memberValue] = await Promise.all([
        api.get(`/api/collaboration/scopes/${scope.id}`),
        api.get(`/api/collaboration/scopes/${scope.id}/members`),
      ]);
      const currentScope = CollaborationScopeSchema.parse(scopeValue);
      const currentMembers = z.strictObject({ members: z.array(CollaborationMemberSchema).max(8) }).parse(memberValue).members;
      setMembers(currentMembers);
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
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSummary, open]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && members.length === 0) void refresh().catch(() => undefined);
  };
  const accepted = members.filter((member) => member.status === "accepted");
  return <div className="relative">
    <button ref={triggerRef} type="button" aria-label="Collaboration access" aria-expanded={open}
      onClick={toggle} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs hover:bg-[var(--bg-hover)]">
      <span aria-hidden className="flex -space-x-1">{accepted.length ? accepted.slice(0, 3).map((member) =>
        <span key={member.actor.actorId} className="grid size-5 place-items-center rounded-full border bg-[var(--bg-surface,var(--background))] text-[9px] font-semibold">
          {member.actor.displayName.slice(0, 1).toUpperCase()}
        </span>) : <span className="grid size-5 place-items-center rounded-full border bg-[var(--bg-surface,var(--background))] text-[9px] font-semibold">S</span>}</span>
      <span className="hidden sm:inline">{scope.membershipMode === "inherited" ? "Project access" : "Shared"}</span>
    </button>
    {open ? <section role="dialog" aria-label="Collaboration access summary"
      className="absolute right-0 top-full z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border bg-background p-4 shadow-xl">
      <div className="flex items-start justify-between gap-3"><div>
        <h2 className="font-semibold">Access</h2>
        <p className="text-xs text-muted-foreground">You are {scope.role === "owner" ? "the owner" : `an ${scope.role}`}.</p>
      </div><button ref={closeRef} type="button" aria-label="Close access summary"
        className="rounded-lg px-2 py-1 text-xs hover:bg-[var(--bg-hover)]" onClick={closeSummary}>Close</button></div>
      {loading ? <p role="status" className="mt-4 text-sm">Loading people…</p> : null}
      {error ? <p role="alert" className="mt-4 text-sm">Access details are unavailable. Try again.</p> : null}
      {!loading && !error ? <ul className="mt-4 space-y-2">{accepted.map((member) => <li key={member.actor.actorId} className="flex items-center gap-3">
        <span aria-hidden className="grid size-8 place-items-center rounded-full bg-[var(--bg-hover)] text-xs font-semibold">{member.actor.displayName.slice(0, 1).toUpperCase()}</span>
        <span className="min-w-0 flex-1 truncate text-sm">{member.actor.displayName}</span><span className="text-xs capitalize text-muted-foreground">{member.role}</span>
      </li>)}</ul> : null}
      {scope.capabilities.manageMembers && scope.membershipMode === "direct" ? <button type="button" className="mt-4 w-full rounded-xl border px-3 py-2 text-sm font-medium"
        onClick={() => { setOpen(false); setManageOpen(true); }}>Manage access</button> : null}
    </section> : null}
    {manageOpen ? <ChatCollaboratorsDialog api={api} scope={scope} members={members}
      onRefresh={refresh} onClose={() => { setManageOpen(false); triggerRef.current?.focus(); }} /> : null}
  </div>;
}

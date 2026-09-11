import {
  CollaborationMemberSchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { Dialog } from "../Dialog.js";
import { ChatCollaboratorsDialog, type CollaborationApi } from "./ChatCollaboratorsDialog.js";

type Scope = z.infer<typeof CollaborationScopeSchema>;
type Member = z.infer<typeof CollaborationMemberSchema>;
type Preflight = z.infer<typeof CollaborationScopePreflightResponseSchema>;
const buttonClass = "rounded-lg border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

export function TerminalSharingButton({ api, runtimeId, terminalId }: {
  api: CollaborationApi;
  runtimeId: string | null;
  terminalId: string;
}) {
  const [surface, setSurface] = useState<"confirm" | "collaborators" | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"unsupported" | "unavailable" | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = async (scopeId: string) => {
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
  };

  const begin = async () => {
    if (!runtimeId) { setError("unavailable"); return; }
    setPending(true);
    setError(null);
    try {
      const result = CollaborationScopePreflightResponseSchema.parse(await api.post(
        `/api/collaboration/runtimes/${runtimeId}/scopes/preflight`,
        { kind: "terminal", resourceId: terminalId },
      ));
      if (!result.eligible || !result.confirmationToken) {
        if (alive.current) setError(result.reason === "unsupported" ? "unsupported" : "unavailable");
        return;
      }
      if (alive.current) { setPreflight(result); setSurface("confirm"); }
    } catch (failure: unknown) {
      console.warn("[terminal-collaboration] preflight failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError("unavailable");
    } finally {
      if (alive.current) setPending(false);
    }
  };

  const confirm = async () => {
    if (!runtimeId || !preflight?.confirmationToken) return;
    setPending(true);
    setError(null);
    try {
      const created = CollaborationScopeSchema.parse(await api.post(
        `/api/collaboration/runtimes/${runtimeId}/scopes`,
        {
          kind: "terminal",
          resourceId: terminalId,
          clientRequestId: crypto.randomUUID(),
          expectedRevision: preflight.resourceRevision,
          confirmationToken: preflight.confirmationToken,
        },
      ));
      await refresh(created.id);
      if (alive.current) setSurface("collaborators");
    } catch (failure: unknown) {
      console.warn("[terminal-collaboration] sharing failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError("unavailable");
    } finally {
      if (alive.current) setPending(false);
    }
  };

  const close = () => { if (!pending) { setSurface(null); setPreflight(null); setScope(null); setError(null); } };
  return <div className="relative inline-flex shrink-0 items-center">
    <button type="button" className={buttonClass} aria-label="Share terminal" disabled={pending}
      aria-expanded={surface !== null} onClick={() => surface ? close() : void begin()}>
      {pending ? "Loading share…" : "Share"}
    </button>
    {error ? <span role="alert" className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border bg-[var(--bg-surface,var(--background))] p-3 shadow-lg">
      {error === "unsupported"
        ? "This terminal cannot be shared safely. It remains private and continues running unchanged."
        : "Terminal sharing is unavailable. Try again later."}
    </span> : null}
    {surface === "confirm" ? <Dialog open aria-label="Confirm terminal sharing" onClose={close}
      className="ph-no-capture w-[min(92vw,560px)] rounded-2xl border p-6"
      style={{ background: "var(--bg-surface, var(--matrix-card, #FCFCF8))",
        color: "var(--text-primary, var(--matrix-card-fg, #32352E))",
        borderColor: "var(--border-default, var(--matrix-border, #D8D6C7))" }}>
      <h2 className="text-lg font-semibold">Share this whole terminal?</h2>
      <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
        Collaborators will see the complete retained output and future live output from this same running session. Output cannot be selectively excluded.
      </p>
      <p className="mt-3 text-sm" style={{ color: "var(--text-secondary)" }}>
        This does not share its parent project, files, sibling terminals, credentials, or permission to create another terminal.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={buttonClass} disabled={pending} onClick={close}>Cancel</button>
        <button type="button" className={buttonClass} disabled={pending} onClick={() => void confirm()}>
          {pending ? "Sharing…" : "Confirm and invite"}
        </button>
      </div>
    </Dialog> : null}
    {surface === "collaborators" && scope ? <ChatCollaboratorsDialog api={api} scope={scope} members={members}
      onRefresh={() => refresh(scope.id)} onClose={close} /> : null}
  </div>;
}

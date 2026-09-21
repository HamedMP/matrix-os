import {
  CollaborationIdSchema,
  CollaborationMemberSchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
  isSafeCollaborationRelativePath,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { ChatCollaboratorsDialog, type CollaborationApi } from "./ChatCollaboratorsDialog.js";

const CatalogResolutionSchema = z.object({
  id: CollaborationIdSchema,
  kind: z.enum(["file", "folder", "app"]),
  path: z.string().min(1).max(4_096),
  incarnation: z.string().min(1).max(256),
  revision: z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/),
}).strict();
const MembersSchema = z.object({ members: z.array(CollaborationMemberSchema).max(8) }).strict();

/** Standalone file, folder and app sharing uses an exact owner catalog identity. */
export function ResourceSharingButton({ api, runtimeId, organizationId, kind, path, projectId }: {
  api: CollaborationApi;
  runtimeId: string | null;
  organizationId: string | null;
  kind: "file" | "folder" | "app";
  path: string;
  projectId?: string;
}) {
  const [scope, setScope] = useState<CollaborationScope | null>(null);
  const [members, setMembers] = useState<z.infer<typeof CollaborationMemberSchema>[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = async (scopeId: string) => {
    const [scopeValue, memberValue] = await Promise.all([
      api.get(`/api/collaboration/scopes/${encodeURIComponent(scopeId)}`),
      api.get(`/api/collaboration/scopes/${encodeURIComponent(scopeId)}/members`),
    ]);
    const current = CollaborationScopeSchema.parse(scopeValue);
    if (current.kind !== kind || current.organizationId !== organizationId) throw new Error("Scope mismatch");
    const currentMembers = MembersSchema.parse(memberValue).members;
    if (alive.current) { setScope(current); setMembers(currentMembers); }
    return { scope: current, members: currentMembers };
  };
  const open = async () => {
    if (!runtimeId || !organizationId || !isSafeCollaborationRelativePath(path) || pending) return;
    setPending(true); setError(false);
    try {
      const runtime = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}`;
      const resolved = CatalogResolutionSchema.parse(await api.post(`${runtime}/catalog/resolve`, {
        kind, path, ...(projectId ? { projectId } : {}),
      }));
      if (resolved.kind !== kind || resolved.path !== path) throw new Error("Catalog mismatch");
      const preflight = CollaborationScopePreflightResponseSchema.parse(await api.post(`${runtime}/scopes/preflight`, {
        kind, resourceId: resolved.id, organizationId,
      }));
      if (!preflight.eligible || !preflight.confirmationToken) throw new Error("Resource unavailable");
      const nextScope = preflight.existingScopeId
        ? CollaborationScopeSchema.parse(await api.get(`/api/collaboration/scopes/${encodeURIComponent(preflight.existingScopeId)}`))
        : CollaborationScopeSchema.parse(await api.post(`${runtime}/scopes`, {
          kind, resourceId: resolved.id, organizationId,
          clientRequestId: crypto.randomUUID(), expectedRevision: preflight.resourceRevision,
          confirmationToken: preflight.confirmationToken,
        }));
      if (nextScope.resourceId !== resolved.id || nextScope.kind !== kind || nextScope.organizationId !== organizationId) {
        throw new Error("Scope mismatch");
      }
      await refresh(nextScope.id);
    } catch (failure: unknown) {
      console.warn("[resource-collaboration] setup failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError(true);
    } finally { if (alive.current) setPending(false); }
  };
  const label = kind === "app" ? "app" : kind;
  return <span className="inline-flex items-center gap-2">
    <button type="button" aria-label={`Share ${label}`} disabled={pending || !runtimeId || !organizationId || !isSafeCollaborationRelativePath(path)}
      aria-expanded={scope !== null} onClick={() => scope ? setScope(null) : void open()}
      className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50">{pending ? "Loading share…" : "Share"}</button>
    {error ? <span role="alert" className="text-xs">Sharing unavailable. The resource remains private.</span> : null}
    {scope ? <ChatCollaboratorsDialog api={api} scope={scope} members={members} onRefresh={() => refresh(scope.id)} onClose={() => setScope(null)} /> : null}
  </span>;
}

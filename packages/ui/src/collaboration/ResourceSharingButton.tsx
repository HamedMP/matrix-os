import {
  CollaborationAppInstanceIdSchema,
  CollaborationIdSchema,
  CollaborationMemberSchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
  isSafeCollaborationRelativePath,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * The owner catalog identifies an app by its registry slug. A launch path such as
 * `apps/notes/index.html` locates assets and never resolves, so the identifier is
 * checked against the same contract schema the resolve request enforces.
 */
function identifies(kind: "file" | "folder" | "app", value: string): boolean {
  return kind === "app"
    ? CollaborationAppInstanceIdSchema.safeParse(value).success
    : isSafeCollaborationRelativePath(value);
}

/**
 * Legacy standalone file, folder and app access management uses an exact owner catalog identity.
 *
 * `path` is a safe relative path for a file or a folder, and the app's registry
 * slug for an app. Callers hold that identity already: the Electron launcher
 * reads it from `/api/apps`, and the web viewer resolves it before bridging the
 * app, so neither has to send an asset location the catalog cannot resolve.
 */
export function ResourceSharingButton({ api, runtimeId, organizationId, kind, path }: {
  api: CollaborationApi;
  runtimeId: string | null;
  organizationId: string | null;
  kind: "file" | "folder" | "app";
  /** Relative path for a file or folder; registry slug for an app. */
  path: string;
  projectId?: string;
}) {
  const [scope, setScope] = useState<CollaborationScope | null>(null);
  const [members, setMembers] = useState<z.infer<typeof CollaborationMemberSchema>[]>([]);
  const [open, setOpen] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = useCallback(async (scopeId: string) => {
    const [scopeValue, memberValue] = await Promise.all([
      api.get(`/api/collaboration/scopes/${encodeURIComponent(scopeId)}`),
      api.get(`/api/collaboration/scopes/${encodeURIComponent(scopeId)}/members`),
    ]);
    const current = CollaborationScopeSchema.parse(scopeValue);
    if (current.kind !== kind || current.organizationId !== organizationId) throw new Error("Scope mismatch");
    const currentMembers = MembersSchema.parse(memberValue).members;
    if (alive.current) { setScope(current); setMembers(currentMembers); }
    return { scope: current, members: currentMembers };
  }, [api, kind, organizationId]);
  useEffect(() => {
    if (!runtimeId || !organizationId || !identifies(kind, path)) return;
    let active = true;
    void (async () => {
      const runtime = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}`;
      const resolved = CatalogResolutionSchema.parse(await api.post(`${runtime}/catalog/resolve`, {
        kind, path, organizationId,
      }));
      if (resolved.kind !== kind || resolved.path !== path) throw new Error("Catalog mismatch");
      const preflight = CollaborationScopePreflightResponseSchema.parse(await api.post(`${runtime}/scopes/preflight`, {
        kind, resourceId: resolved.id, organizationId,
      }));
      if (!preflight.existingScopeId || !active) return;
      const nextScope = CollaborationScopeSchema.parse(await api.get(
        `/api/collaboration/scopes/${encodeURIComponent(preflight.existingScopeId)}`,
      ));
      if (nextScope.resourceId !== resolved.id || nextScope.kind !== kind || nextScope.organizationId !== organizationId) {
        throw new Error("Scope mismatch");
      }
      await refresh(nextScope.id);
    })().catch((failure: unknown) => {
      console.warn("[resource-collaboration] legacy access lookup failed", failure instanceof Error ? failure.name : "UnknownError");
    });
    return () => { active = false; };
  }, [api, kind, organizationId, path, refresh, runtimeId]);
  const label = kind === "app" ? "app" : kind;
  if (!scope) return null;
  return <span className="inline-flex items-center gap-2">
    <button type="button" aria-label={`Manage ${label} access`} aria-expanded={open} onClick={() => setOpen((value) => !value)}
      className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50">Manage access</button>
    {open ? <ChatCollaboratorsDialog api={api} scope={scope} members={members} onRefresh={() => refresh(scope.id)} onClose={() => setOpen(false)} /> : null}
  </span>;
}

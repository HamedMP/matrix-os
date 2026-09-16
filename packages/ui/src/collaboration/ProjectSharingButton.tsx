import {
  CollaborationMemberSchema,
  CollaborationProjectInventorySchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
  type CollaborationProjectInventory,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { ChatCollaboratorsDialog, type CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { ProjectSharingDialog } from "./ProjectSharingDialog.js";

// react-doctor-disable-next-line react-doctor/zod-v4-no-deprecated-schema-apis -- imported from zod/v4; array max is the current bounded-array API and is verified by the package typecheck.
const MembersSchema = z.object({ members: z.array(CollaborationMemberSchema).max(8) }).strict();
const buttonClass = "rounded-lg border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

export function ProjectSharingButton({ api, runtimeId, projectId, projectName }: {
  api: CollaborationApi;
  runtimeId: string | null;
  projectId: string;
  projectName: string;
}) {
  const [surface, setSurface] = useState<"inventory" | "members" | null>(null);
  const [scope, setScope] = useState<CollaborationScope | null>(null);
  const [inventory, setInventory] = useState<CollaborationProjectInventory | null>(null);
  const [members, setMembers] = useState<z.infer<typeof CollaborationMemberSchema>[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refreshScope = async (scopeId: string) => {
    const [scopeValue, membersValue] = await Promise.all([
      api.get(`/api/collaboration/scopes/${scopeId}`),
      api.get(`/api/collaboration/scopes/${scopeId}/members`),
    ]);
    const nextScope = CollaborationScopeSchema.parse(scopeValue);
    if (nextScope.kind !== "project" || nextScope.resourceId !== projectId) {
      throw new Error("Project scope mismatch");
    }
    const nextMembers = MembersSchema.parse(membersValue).members;
    if (alive.current) {
      setScope(nextScope);
      setMembers(nextMembers);
    }
    return { scope: nextScope, members: nextMembers };
  };

  const refreshInventory = async (scopeId: string) => {
    const next = CollaborationProjectInventorySchema.parse(await api.get(
      `/api/collaboration/scopes/${scopeId}/project/inventory`,
    ));
    if (next.projectId !== projectId || next.scopeId !== scopeId) {
      throw new Error("Project inventory mismatch");
    }
    if (alive.current) setInventory(next);
    return next;
  };

  const begin = async () => {
    if (!runtimeId || pending) {
      setError(true);
      return;
    }
    setPending(true);
    setError(false);
    try {
      const preflight = CollaborationScopePreflightResponseSchema.parse(await api.post(
        `/api/collaboration/runtimes/${runtimeId}/scopes/preflight`,
        { kind: "project", resourceId: projectId },
      ));
      if (!preflight.eligible || !preflight.confirmationToken) throw new Error("Project unavailable");
      if (preflight.existingScopeId) {
        const refreshed = await refreshScope(preflight.existingScopeId);
        if (refreshed.scope.lifecycle === "shared" || refreshed.scope.lifecycle === "archived") {
          if (alive.current) setSurface("members");
        } else {
          await refreshInventory(refreshed.scope.id);
          if (alive.current) setSurface("inventory");
        }
        return;
      }
      const created = CollaborationScopeSchema.parse(await api.post(
        `/api/collaboration/runtimes/${runtimeId}/scopes`,
        {
          kind: "project",
          resourceId: projectId,
          clientRequestId: crypto.randomUUID(),
          expectedRevision: preflight.resourceRevision,
          confirmationToken: preflight.confirmationToken,
        },
      ));
      const refreshed = await refreshScope(created.id);
      if (refreshed.scope.lifecycle === "shared") {
        if (alive.current) setSurface("members");
      } else {
        await refreshInventory(created.id);
        if (alive.current) setSurface("inventory");
      }
    } catch (failure: unknown) {
      console.warn("[project-collaboration] setup failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setPending(false);
    }
  };

  const close = () => {
    if (pending) return;
    setSurface(null);
    setInventory(null);
    setScope(null);
    setError(false);
  };

  return <div className="relative inline-flex shrink-0 items-center">
    <button type="button" className={buttonClass} aria-label="Share project" disabled={pending || !runtimeId}
      aria-expanded={surface !== null} onClick={() => surface ? close() : void begin()}>
      {pending || !runtimeId ? "Loading share…" : "Share"}
    </button>
    {error ? <span role="alert" className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border bg-[var(--bg-surface,var(--background))] p-3 shadow-lg">
      Project sharing is unavailable. The project remains private and unchanged.
    </span> : null}
    {surface === "inventory" && scope && inventory ? <ProjectSharingDialog
      api={api}
      scope={scope}
      projectName={projectName}
      inventory={inventory}
      refreshInventory={() => refreshInventory(scope.id)}
      onManageMembers={() => setSurface("members")}
      onClose={close}
    /> : null}
    {surface === "members" && scope ? <ChatCollaboratorsDialog
      api={api}
      scope={scope}
      members={members}
      onRefresh={() => refreshScope(scope.id)}
      onClose={() => {
        if (scope.lifecycle === "shared") close();
        else {
          void refreshInventory(scope.id).then(() => {
            if (alive.current) setSurface("inventory");
          }).catch((failure: unknown) => {
            console.warn("[project-collaboration] inventory refresh failed", failure instanceof Error ? failure.name : "UnknownError");
            if (alive.current) setError(true);
          });
        }
      }}
    /> : null}
  </div>;
}

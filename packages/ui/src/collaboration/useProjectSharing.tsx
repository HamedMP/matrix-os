import {
  CollaborationMemberSchema,
  CollaborationProjectInventorySchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
  type CollaborationProjectInventory,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod/v4";
import { ChatCollaboratorsDialog, type CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { ProjectSharingDialog } from "./ProjectSharingDialog.js";

// react-doctor-disable-next-line react-doctor/zod-v4-no-deprecated-schema-apis -- imported from zod/v4; array max is the current bounded-array API and is verified by the package typecheck.
const MembersSchema = z.object({ members: z.array(CollaborationMemberSchema).max(8) }).strict();

export const PROJECT_SHARING_UNAVAILABLE_MESSAGE = "Project sharing is unavailable. The project remains private and unchanged.";

const PUBLICATION_POLL_MS = 1_000;
const PUBLICATION_WAIT_MS = 60_000;

export interface ProjectSharingController {
  pending: boolean;
  open: boolean;
  error: boolean;
  start(): void;
  close(): void;
  dialogs: ReactNode;
}

/**
 * Owns the whole-project preflight, inventory confirmation, and member manager
 * so buttons and short-lived menu items can launch the same sharing flow.
 */
export function useProjectSharing({ api, runtimeId, organizationId, projectId, projectName, onClose }: {
  api: CollaborationApi;
  runtimeId: string | null;
  organizationId: string | null;
  projectId: string;
  projectName: string;
  onClose?: () => void;
}): ProjectSharingController {
  const [surface, setSurface] = useState<"inventory" | "members" | null>(null);
  const [scope, setScope] = useState<CollaborationScope | null>(null);
  const [inventory, setInventory] = useState<CollaborationProjectInventory | null>(null);
  const [members, setMembers] = useState<z.infer<typeof CollaborationMemberSchema>[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  const starting = useRef(false);
  /** The scope whose publication is being awaited; cleared by close so the wait ends with the dialog. */
  const publishingScope = useRef<string | null>(null);
  const [publication, setPublication] = useState<"idle" | "waiting" | "delayed">("idle");

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /** Reads the scope and its members without touching state, so a caller can still discard them. */
  const readScopeState = async (scopeId: string) => {
    const [scopeValue, membersValue] = await Promise.all([
      api.get(`/api/collaboration/scopes/${scopeId}`),
      api.get(`/api/collaboration/scopes/${scopeId}/members`),
    ]);
    const nextScope = CollaborationScopeSchema.parse(scopeValue);
    if (nextScope.kind !== "project" || nextScope.resourceId !== projectId) {
      throw new Error("Project scope mismatch");
    }
    return { scope: nextScope, members: MembersSchema.parse(membersValue).members };
  };

  const refreshScope = async (scopeId: string) => {
    const next = await readScopeState(scopeId);
    if (alive.current) {
      setScope(next.scope);
      setMembers(next.members);
    }
    return next;
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
    if (starting.current) return;
    if (!runtimeId || !organizationId) {
      setError(true);
      return;
    }
    starting.current = true;
    setPending(true);
    setError(false);
    try {
      const preflight = CollaborationScopePreflightResponseSchema.parse(await api.post(
        `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes/preflight`,
        { kind: "project", resourceId: projectId, organizationId },
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
        `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes`,
        {
          kind: "project",
          resourceId: projectId,
          organizationId,
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
      starting.current = false;
      if (alive.current) setPending(false);
    }
  };

  /**
   * A confirmed project publishes on the owner's home asynchronously; until the platform lists it,
   * the scope key cannot reach it. Read it once a second, for a bounded time, and show the shared
   * project's collaborators as soon as it is shared. Closing the dialog ends the wait.
   */
  const awaitPublication = async (scopeId: string) => {
    if (publishingScope.current === scopeId) return;
    publishingScope.current = scopeId;
    setPublication("waiting");
    const current = () => alive.current && publishingScope.current === scopeId;
    const deadline = Date.now() + PUBLICATION_WAIT_MS;
    let lastFailure = "none";
    while (current() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PUBLICATION_POLL_MS));
      if (!current()) return;
      try {
        const next = await readScopeState(scopeId);
        // The owner may have closed the dialog while the read was in flight.
        if (!current()) return;
        if (next.scope.lifecycle === "shared") {
          publishingScope.current = null;
          setPublication("idle");
          setScope(next.scope);
          setMembers(next.members);
          setSurface("members");
          return;
        }
      } catch (failure: unknown) {
        // Expected while the home finishes publishing: the scope is not routable yet.
        lastFailure = failure instanceof Error ? failure.name : "UnknownError";
      }
    }
    if (current()) {
      publishingScope.current = null;
      setPublication("delayed");
      console.warn("[project-collaboration] publication still pending", lastFailure);
    }
  };

  const close = () => {
    if (pending) return;
    publishingScope.current = null;
    setPublication("idle");
    setSurface(null);
    setInventory(null);
    setScope(null);
    setError(false);
    onClose?.();
  };

  const dialogs = <>
    {surface === "inventory" && scope && inventory ? <ProjectSharingDialog
      api={api}
      scope={scope}
      projectName={projectName}
      inventory={inventory}
      refreshInventory={() => refreshInventory(scope.id)}
      onManageMembers={() => setSurface("members")}
      onConfirmed={() => { void awaitPublication(scope.id); }}
      publicationDelayed={publication === "delayed"}
      onCheckPublication={() => { void awaitPublication(scope.id); }}
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
  </>;

  return { pending, open: surface !== null, error, start: () => { void begin(); }, close, dialogs };
}

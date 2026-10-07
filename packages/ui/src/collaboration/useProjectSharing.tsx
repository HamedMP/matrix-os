import {
  CollaborationGrantSchema,
  CollaborationProjectInventorySchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
  type CollaborationProjectInventory,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { ProjectSharingDialog } from "./ProjectSharingDialog.js";

// react-doctor-disable-next-line react-doctor/zod-v4-no-deprecated-schema-apis -- imported from zod/v4; array max is the current bounded-array API and is verified by the package typecheck.
const GrantsSchema = z.array(CollaborationGrantSchema).max(100);

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
export function useProjectSharing({ api, runtimeId, organizationId, organizationName: selectedOrganizationName, projectId, projectName, onClose }: {
  api: CollaborationApi;
  runtimeId: string | null;
  organizationId: string | null;
  organizationName?: string | null;
  projectId: string;
  projectName: string;
  onClose?: () => void;
}): ProjectSharingController {
  const [surface, setSurface] = useState<"dialog" | null>(null);
  const [scope, setScope] = useState<CollaborationScope | null>(null);
  const [inventory, setInventory] = useState<CollaborationProjectInventory | null>(null);
  const organizationName = selectedOrganizationName ?? undefined;
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

  /** Reads the project scope without touching state, so a caller can still discard it. */
  const readScopeState = async (scopeId: string) => {
    const scopeValue = await api.get(`/api/collaboration/scopes/${scopeId}`);
    const nextScope = CollaborationScopeSchema.parse(scopeValue);
    if (nextScope.kind !== "project" || nextScope.resourceId !== projectId) {
      throw new Error("Project scope mismatch");
    }
    return nextScope;
  };

  const refreshScope = async (scopeId: string) => {
    const next = await readScopeState(scopeId);
    if (alive.current) {
      setScope(next);
    }
    return next;
  };

  /** First-time project sharing starts with the Figma baseline: everyone in the organization is an Editor. */
  const ensureDefaultGrant = async (currentScope: CollaborationScope) => {
    const base = `/api/collaboration/scopes/${encodeURIComponent(currentScope.id)}`;
    const live = GrantsSchema.parse(await api.get(`${base}/grants`))
      .filter((grant) => grant.state === "active" || grant.state === "pending");
    // Defaults apply only to a genuinely untouched scope. Any live grant means
    // the owner already selected an audience, including Restricted + direct people.
    if (live.length > 0) return currentScope;
    await api.post(`${base}/grants`, {
      clientRequestId: crypto.randomUUID(), expectedRevision: currentScope.revision,
      audience: { kind: "organization" }, preset: "contributor",
    });
    // The revision-bound inventory read immediately after this mutation is the
    // authoritative confirmation revision. Avoid an extra scope read here so
    // publication polling remains the only post-confirmation scope reader.
    return currentScope;
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
      const preflightValue = await api.post(`/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes/preflight`,
        { kind: "project", resourceId: projectId, organizationId });
      const preflight = CollaborationScopePreflightResponseSchema.parse(preflightValue);
      if (!preflight.eligible || !preflight.confirmationToken) throw new Error("Project unavailable");
      if (preflight.existingScopeId) {
        const refreshed = await refreshScope(preflight.existingScopeId);
        if (refreshed.lifecycle !== "shared" && refreshed.lifecycle !== "archived") await refreshInventory(refreshed.id);
        if (alive.current) setSurface("dialog");
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
      let refreshed = await refreshScope(created.id);
      if (refreshed.lifecycle === "private") refreshed = await ensureDefaultGrant(refreshed);
      if (refreshed.lifecycle !== "shared" && refreshed.lifecycle !== "archived") await refreshInventory(created.id);
      if (alive.current) setSurface("dialog");
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
        if (next.lifecycle === "shared") {
          publishingScope.current = null;
          setPublication("idle");
          setScope(next);
          setSurface("dialog");
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
    {surface === "dialog" && scope ? <ProjectSharingDialog
      api={api}
      scope={scope}
      projectName={projectName}
      {...(organizationName ? { organizationName } : {})}
      {...(inventory ? { inventory } : {})}
      refreshInventory={() => refreshInventory(scope.id)}
      onAccessChanged={async () => {
        const current = await refreshScope(scope.id);
        if (current.lifecycle !== "shared" && current.lifecycle !== "archived") return refreshInventory(scope.id);
        return current;
      }}
      onConfirmed={() => { void awaitPublication(scope.id); }}
      publicationDelayed={publication === "delayed"}
      onCheckPublication={() => { void awaitPublication(scope.id); }}
      onClose={close}
    /> : null}
  </>;

  return { pending, open: surface !== null, error, start: () => { void begin(); }, close, dialogs };
}

"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { CollaborationDirectApi } from "@matrix-os/ui";
import { createShellCollaborationApi, releaseShellCollaborationApi } from "@/lib/collaboration";
import { useCollaborationOrganization } from "./collaboration-organization-state";

/** Owns one direct API and recreates it after React Strict Mode's effect probe. */
export function useShellCollaborationApi(
  baseUrl: string | null,
  enabled: boolean,
  identity = baseUrl ?? "",
): CollaborationDirectApi | null {
  const key = enabled && baseUrl ? identity : null;
  const [state, setState] = useState<{ key: string | null; api: CollaborationDirectApi | null } | null>(null);
  const api = state?.key === key ? state.api : null;
  useEffect(() => {
    const next = key && baseUrl ? createShellCollaborationApi(baseUrl) : null;
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- the API is an effect-owned external session; publishing the instance after creation is what makes Strict Mode cleanup/recreation safe.
    setState({ key, api: next });
    return () => { if (next) releaseShellCollaborationApi(next); };
  }, [baseUrl, key]);
  return api;
}

/** Hide organization-only UI only when a complete membership listing confirms none. */
export function OrganizationOnly({ children }: { children: ReactNode }) {
  const { status } = useCollaborationOrganization();
  return status === "none" ? null : <>{children}</>;
}

/**
 * Supplies the active organization to an organization-only subtree. Loading and
 * failures stay visible so a real member never sees controls flash or disappear.
 * The subtree is keyed so organization-bound state cannot survive a switch.
 */
export function CollaborationOrganization({ children }: {
  children: (organizationId: string | null) => ReactNode;
}) {
  const { status, organizationId } = useCollaborationOrganization();
  if (status === "none") return null;
  return (
    <Fragment key={organizationId ?? status}>
      {children(organizationId)}
    </Fragment>
  );
}

import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { CollaborationDirectApi } from "@matrix-os/ui";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

/** Owns one direct API and recreates it after React Strict Mode's effect probe. */
export function useDesktopCollaborationApi(
  platformHost: string,
  enabled: boolean,
  identity = platformHost,
): CollaborationDirectApi | null {
  const key = enabled && platformHost ? identity : null;
  const [state, setState] = useState<{ key: string | null; api: CollaborationDirectApi | null } | null>(null);
  const api = state?.key === key ? state.api : null;
  useEffect(() => {
    const next = key ? createDesktopCollaborationApi(platformHost) : null;
    setState({ key, api: next });
    return () => { if (next) releaseDesktopCollaborationApi(next); };
  }, [key, platformHost]);
  return api;
}

/**
 * Electron Desktop counterpart of the shell's CollaborationOrganization gate
 * (S20 / T101): renders `children` with the active organization from the
 * trusted-core connection state. A complete platform listing is required before
 * an empty membership can hide controls; loading and failed discovery remain visible.
 * The subtree is keyed so a switch remounts it and no organization-bound state survives.
 */
export function DesktopCollaborationOrganization({ children }: {
  children: (organizationId: string | null) => ReactNode;
}) {
  const organizationId = useConnection((state) => state.organizationId);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  if (organizationStatus === "none") return null;
  const verifiedOrganizationId = organizationStatus === "member" ? organizationId : null;
  return <Fragment key={verifiedOrganizationId ?? organizationStatus}>{children(verifiedOrganizationId)}</Fragment>;
}

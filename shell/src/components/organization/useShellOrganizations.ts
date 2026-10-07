"use client";

import { useAuth } from "@clerk/nextjs";
import { OrganizationManagementListSchema, type OrganizationManagementSummary } from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi, releaseShellCollaborationApi } from "@/lib/collaboration";

export type ShellOrganizationListing =
  | { state: "loading" }
  | { state: "loaded"; organizations: OrganizationManagementSummary[] }
  | { state: "failed" };

export function useShellOrganizations(refreshKey = 0): ShellOrganizationListing {
  const { userId } = useAuth();
  const origin = useBrowserOrigin();
  const requestKey = origin && userId ? `${origin}:${userId}` : null;
  const [result, setResult] = useState<{ requestKey: string | null; listing: ShellOrganizationListing }>({
    requestKey: null,
    listing: { state: "loading" },
  });

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- this account-scoped directory read has no server-rendered consumer; stale responses are discarded on sign-out/account changes.
  useEffect(() => {
    if (!origin || !userId) return;
    const api = createShellCollaborationApi(origin);
    let active = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseShellCollaborationApi(api);
    };
    void api.get("/api/organizations").then((value) => {
      if (!active) return;
      setResult({ requestKey, listing: { state: "loaded", organizations: OrganizationManagementListSchema.parse(value).organizations } });
    }).catch((error: unknown) => {
      console.warn("[organization-management] organizations unavailable", error instanceof Error ? error.name : "UnknownError");
      if (active) setResult({ requestKey, listing: { state: "failed" } });
    }).finally(release);
    return () => {
      active = false;
      release();
    };
  }, [origin, refreshKey, requestKey, userId]);

  return result.requestKey === requestKey ? result.listing : { state: "loading" };
}

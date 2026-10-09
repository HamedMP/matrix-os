"use client";

import {
  OrganizationManagementInvitationsSchema,
  OrganizationManagementMembersPageSchema,
  type OrganizationManagementInvitation,
  type OrganizationManagementMember,
} from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi, releaseShellCollaborationApi } from "@/lib/collaboration";

export type ShellOrganizationDirectory =
  | { state: "loading"; members: []; invitations: [] }
  | { state: "loaded"; members: OrganizationManagementMember[]; invitations: OrganizationManagementInvitation[] }
  | { state: "failed"; members: []; invitations: [] };

export function useShellOrganizationDirectory(organizationId: string | null, admin: boolean, refreshKey = 0): ShellOrganizationDirectory {
  const origin = useBrowserOrigin();
  const requestKey = origin && organizationId ? `${origin}:${organizationId}:${admin ? "admin" : "member"}` : null;
  const [result, setResult] = useState<{ requestKey: string | null; directory: ShellOrganizationDirectory }>({
    requestKey: null,
    directory: { state: "loading", members: [], invitations: [] },
  });

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- changing the active Clerk organization is the client-side read boundary; stale responses are discarded.
  useEffect(() => {
    if (!origin || !organizationId) return;
    const api = createShellCollaborationApi(origin);
    let active = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseShellCollaborationApi(api);
    };
    const listMembers = async () => {
      const members: OrganizationManagementMember[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const path = `/api/organizations/${organizationId}/members${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
        const page = OrganizationManagementMembersPageSchema.parse(await api.get(path));
        members.push(...page.members);
        if (!page.nextCursor || cursors.has(page.nextCursor)) break;
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return members.slice(0, 2_000);
    };
    void Promise.all([
      listMembers(),
      admin
        ? api.get(`/api/organizations/${organizationId}/invitations`).then((value) => OrganizationManagementInvitationsSchema.parse(value).invitations)
        : Promise.resolve([]),
    ]).then(([members, invitations]) => {
      if (active) setResult({ requestKey, directory: { state: "loaded", members, invitations } });
    }).catch((error: unknown) => {
      console.warn("[organization-management] directory unavailable", error instanceof Error ? error.name : "UnknownError");
      if (active) setResult({ requestKey, directory: { state: "failed", members: [], invitations: [] } });
    }).finally(release);
    return () => {
      active = false;
      release();
    };
  }, [admin, organizationId, origin, refreshKey, requestKey]);

  return result.requestKey === requestKey ? result.directory : { state: "loading", members: [], invitations: [] };
}

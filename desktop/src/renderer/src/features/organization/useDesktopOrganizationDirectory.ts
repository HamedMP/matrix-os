import {
  OrganizationManagementInvitationsSchema,
  OrganizationManagementMembersPageSchema,
  type OrganizationManagementInvitation,
  type OrganizationManagementMember,
} from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

export type DesktopOrganizationDirectory =
  | { state: "loading"; members: []; invitations: [] }
  | { state: "loaded"; members: OrganizationManagementMember[]; invitations: OrganizationManagementInvitation[] }
  | { state: "failed"; members: []; invitations: [] };

export function useDesktopOrganizationDirectory(organizationId: string | null, admin: boolean, refreshKey = 0): DesktopOrganizationDirectory {
  const platformHost = useConnection((state) => state.platformHost);
  const userId = useConnection((state) => state.userId);
  const [directory, setDirectory] = useState<DesktopOrganizationDirectory>({ state: "loading", members: [], invitations: [] });

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the selected organization is the read boundary; stale responses are discarded on selection/account changes.
  useEffect(() => {
    if (!organizationId || !userId) return;
    const api = createDesktopCollaborationApi(platformHost);
    if (!api) {
      setDirectory({ state: "failed", members: [], invitations: [] });
      return;
    }
    let active = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseDesktopCollaborationApi(api);
    };
    setDirectory({ state: "loading", members: [], invitations: [] });
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
      if (active) setDirectory({ state: "loaded", members, invitations });
    }).catch((error: unknown) => {
      console.warn("[organization-management] directory unavailable", error instanceof Error ? error.name : "UnknownError");
      if (active) setDirectory({ state: "failed", members: [], invitations: [] });
    }).finally(release);
    return () => {
      active = false;
      release();
    };
  }, [admin, organizationId, platformHost, refreshKey, userId]);

  return directory;
}

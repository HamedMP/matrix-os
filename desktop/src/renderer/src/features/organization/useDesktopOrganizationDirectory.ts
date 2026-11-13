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

const LOADING: DesktopOrganizationDirectory = { state: "loading", members: [], invitations: [] };

/**
 * `profileImages` opts into member photos. Platforms that predate the opt-in reject the
 * unknown query, so the first page is retried once without it and members fall back to initials.
 */
export function useDesktopOrganizationDirectory(
  organizationId: string | null,
  admin: boolean,
  refreshKey = 0,
  { profileImages = false }: { profileImages?: boolean } = {},
): DesktopOrganizationDirectory {
  const platformHost = useConnection((state) => state.platformHost);
  const userId = useConnection((state) => state.userId);
  // Tagged with the organization it was read for, so a selection change never shows the previous roster.
  const [directory, setDirectory] = useState<{ organizationId: string | null; value: DesktopOrganizationDirectory }>({ organizationId: null, value: LOADING });

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the selected organization is the read boundary; stale responses are discarded on selection/account changes.
  useEffect(() => {
    if (!organizationId || !userId) return;
    const api = createDesktopCollaborationApi(platformHost);
    if (!api) {
      setDirectory({ organizationId, value: { state: "failed", members: [], invitations: [] } });
      return;
    }
    let active = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseDesktopCollaborationApi(api);
    };
    setDirectory({ organizationId, value: LOADING });
    const listMembers = async () => {
      const members: OrganizationManagementMember[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let images = profileImages;
      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const query = new URLSearchParams();
        if (cursor) query.set("cursor", cursor);
        if (images) query.set("include", "imageUrl");
        const path = `/api/organizations/${organizationId}/members${query.size ? `?${query}` : ""}`;
        let raw: unknown;
        try {
          raw = await api.get(path);
        } catch (error: unknown) {
          if (!images || pageIndex > 0) throw error;
          console.warn("[organization-management] member photos unavailable", error instanceof Error ? error.name : "UnknownError");
          images = false;
          pageIndex -= 1;
          continue;
        }
        const page = OrganizationManagementMembersPageSchema.parse(raw);
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
      if (active) setDirectory({ organizationId, value: { state: "loaded", members, invitations } });
    }).catch((error: unknown) => {
      console.warn("[organization-management] directory unavailable", error instanceof Error ? error.name : "UnknownError");
      if (active) setDirectory({ organizationId, value: { state: "failed", members: [], invitations: [] } });
    }).finally(release);
    return () => {
      active = false;
      release();
    };
  }, [admin, organizationId, platformHost, profileImages, refreshKey, userId]);

  return directory.organizationId === organizationId ? directory.value : LOADING;
}

import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { useDesktopOrganizations } from "../collaboration/useDesktopOrganizations";
import { useAppOrgSharing, type AppOrgSharing } from "../../../../../../shell/src/components/app-sites/app-org-sharing";
import { AppOrgSharingDetails, AppOrgSharingSummary } from "../../../../../../shell/src/components/app-sites/AppOrgSharingSection";
import { DesktopOrganizationMemberList } from "./DesktopOrganizationMemberList";
import { DesktopShareButton } from "./DesktopShareButton";

export type DesktopAppOrgSharing = AppOrgSharing;

/** Electron's organization source: the signed-in connection and the platform membership listing. */
export function useDesktopAppOrgSharing({ appId, api, buildEpoch }: { appId: string; api: ApiClient; buildEpoch: number }) {
  const selectedOrganizationId = useConnection((state) => state.organizationId);
  const status = useConnection((state) => state.organizationStatus);
  const listing = useDesktopOrganizations();
  return useAppOrgSharing({ appId, api, buildEpoch, organizations: { selectedOrganizationId, status, listing } });
}

export function DesktopAppOrgSharingSummary({ controller }: { controller: DesktopAppOrgSharing }) {
  return <AppOrgSharingSummary controller={controller} />;
}

/** Owner-home app sharing stays separate from Matrix.page publication. */
export function DesktopAppOrgSharingDetails({ controller }: { controller: DesktopAppOrgSharing }) {
  const { organizationId, organizationName: name } = controller;
  return <AppOrgSharingDetails controller={controller} Button={DesktopShareButton} members={organizationId ? (
    <DesktopOrganizationMemberList organizationId={organizationId} organizationName={name ?? "your organization"} />
  ) : null} />;
}

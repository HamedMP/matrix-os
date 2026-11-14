import { useState } from "react";
import { useConnection } from "../../stores/connection";
import { useDesktopOrganizationDirectory } from "../organization/useDesktopOrganizationDirectory";
import { AppOrgMemberRoster } from "../../../../../../shell/src/components/app-sites/AppOrgMemberRoster";
import { DesktopShareButton } from "./DesktopShareButton";

/** Electron's roster source: member pages with profile photos, read through the platform client. */
export function DesktopOrganizationMemberList({ organizationId, organizationName }: {
  organizationId: string;
  organizationName: string;
}) {
  const userId = useConnection((state) => state.userId);
  const [retryKey, setRetryKey] = useState(0);
  const directory = useDesktopOrganizationDirectory(organizationId, false, retryKey, { profileImages: true });
  return <AppOrgMemberRoster directory={directory} organizationName={organizationName} currentActorId={userId}
    onRetry={() => setRetryKey((key) => key + 1)} Button={DesktopShareButton} />;
}

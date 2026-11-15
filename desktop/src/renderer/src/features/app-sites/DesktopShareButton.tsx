import { Button } from "../../design/primitives";
import type { AppOrgShareButton } from "../../../../../../shell/src/components/app-sites/AppOrgSharingSection";

/** Electron's control styling for the shared organization-sharing presentation. */
export const DesktopShareButton: AppOrgShareButton = ({ tone, ...props }) => (
  <Button variant={tone === "primary" ? "primary" : "subtle"} {...props} />
);

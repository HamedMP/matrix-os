"use client";

import { useAuth } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { isSelfHostedRuntime, SELF_HOSTED_SHELL_USER_ID } from "@/lib/self-host-mode";
import { organizationDriveNavigationIdentity } from "@/stores/organization-drive-navigation";

type ShellFileAuthorityProps = { children(identity: string, gatewayUrl: string): ReactNode };

export function ShellFileAuthority({ children }: ShellFileAuthorityProps) {
  const gatewayUrl = getGatewayUrl();
  // The server flag and the root document attribute carry the same self-hosted value.
  // react-doctor-disable-next-line react-doctor/no-hydration-branch-on-browser-global
  if (isSelfHostedRuntime()) {
    return children(organizationDriveNavigationIdentity(SELF_HOSTED_SHELL_USER_ID, null, gatewayUrl), gatewayUrl);
  }
  return <ClerkFileAuthority gatewayUrl={gatewayUrl}>{children}</ClerkFileAuthority>;
}

function ClerkFileAuthority({ children, gatewayUrl }: ShellFileAuthorityProps & { gatewayUrl: string }) {
  const { userId, sessionId } = useAuth();
  return children(organizationDriveNavigationIdentity(userId, sessionId, gatewayUrl), gatewayUrl);
}

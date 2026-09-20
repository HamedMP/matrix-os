import type { ReactNode } from "react";
import { useConnection } from "../../stores/connection";

/**
 * Electron Desktop counterpart of the shell's CollaborationOrganization gate
 * (S20 / T101): renders `children` with the active organization from the
 * trusted-core connection state. Sharing exists only inside an organization,
 * so share controls stay disabled while it is null.
 */
export function DesktopCollaborationOrganization({ children }: {
  children: (organizationId: string | null) => ReactNode;
}) {
  const organizationId = useConnection((state) => state.organizationId);
  return <>{children(organizationId)}</>;
}

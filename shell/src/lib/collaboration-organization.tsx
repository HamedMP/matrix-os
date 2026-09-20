"use client";

import { useOrganization } from "@clerk/nextjs";
import type { ReactNode } from "react";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";

/**
 * Renders `children` with the Clerk organization the signed-in user has
 * active. Sharing exists only inside an organization (S20 / T101), so every
 * share request carries this identifier and the share controls stay disabled
 * without one. The E2E bypass shell runs without a ClerkProvider, so it
 * renders without an organization instead of calling Clerk hooks.
 */
export function CollaborationOrganization({ children }: {
  children: (organizationId: string | null) => ReactNode;
}) {
  if (e2eBypass) return <>{children(null)}</>;
  return <ClerkCollaborationOrganization>{children}</ClerkCollaborationOrganization>;
}

function ClerkCollaborationOrganization({ children }: {
  children: (organizationId: string | null) => ReactNode;
}) {
  const { organization } = useOrganization();
  return <>{children(organization?.id ?? null)}</>;
}

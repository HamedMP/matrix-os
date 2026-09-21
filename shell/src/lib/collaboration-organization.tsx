"use client";

import { useOrganization } from "@clerk/nextjs";
import { Fragment, type ReactNode } from "react";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";

/**
 * Renders `children` with the Clerk organization the signed-in user has
 * active. Sharing exists only inside an organization (S20 / T101), so every
 * share request carries this identifier and the share controls stay disabled
 * without one. The E2E bypass shell runs without a ClerkProvider, so it
 * renders without an organization instead of calling Clerk hooks. The subtree
 * is keyed by the organization so switching the active organization remounts
 * it: no pending preflight token or open scope can carry over to another one.
 */
export function CollaborationOrganization({ children }: {
  children: (organizationId: string | null) => ReactNode;
}) {
  if (e2eBypass) return <Fragment key="no-organization">{children(null)}</Fragment>;
  return <ClerkCollaborationOrganization>{children}</ClerkCollaborationOrganization>;
}

function ClerkCollaborationOrganization({ children }: {
  children: (organizationId: string | null) => ReactNode;
}) {
  const { organization } = useOrganization();
  const organizationId = organization?.id ?? null;
  return <Fragment key={organizationId ?? "no-organization"}>{children(organizationId)}</Fragment>;
}

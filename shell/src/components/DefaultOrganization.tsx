"use client";

import { useOrganization, useOrganizationList } from "@clerk/nextjs";
import { pickDefaultOrganizationId } from "@matrix-os/ui/default-organization";
import { useEffect, useRef } from "react";

/**
 * Activates the member's oldest organization when they have none active.
 *
 * Matrix adds people to organizations; members never have to activate one. Clerk
 * leaves the active organization empty until something sets it, so without this every
 * share control would read "Join an organization to share" for a member who belongs
 * to one. A user in no organization is left individual and sharing stays disabled.
 *
 * Mounted once beside the ClerkProvider so it covers every Web view, not only those
 * that render the account menu. The oldest is chosen among the memberships Clerk has
 * loaded; switching stays in the account menu (OrganizationMenuItems).
 */
export function DefaultOrganization() {
  const { isLoaded: organizationLoaded, organization } = useOrganization();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  // One attempt per organization: a failed activation must not retry on every render.
  const attempted = useRef<string | null>(null);
  const memberships = userMemberships?.data;
  const defaultId = pickDefaultOrganizationId(memberships?.map((membership) => membership.organization.id) ?? []);
  const needsDefault = organizationLoaded && isLoaded && !organization && defaultId !== null;

  useEffect(() => {
    if (!needsDefault || !setActive || !defaultId || attempted.current === defaultId) return;
    attempted.current = defaultId;
    void setActive({ organization: defaultId }).catch((error: unknown) => {
      console.warn(
        "[collaboration-organization] default activation failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
  }, [defaultId, needsDefault, setActive]);

  return null;
}

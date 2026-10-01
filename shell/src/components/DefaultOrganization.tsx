"use client";

import { useAuth, useOrganization, useOrganizationList } from "@clerk/nextjs";
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
 * that render the account menu. Every membership page is loaded first, since the oldest
 * organization can be on any page; switching stays in the account menu
 * (OrganizationMenuItems).
 */
export function DefaultOrganization() {
  const { userId } = useAuth();
  const { isLoaded: organizationLoaded, organization } = useOrganization();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  // One attempt per account and organization: a failed activation must not retry on every
  // render, and the next account in this tab must not inherit the previous one's attempt.
  const attempted = useRef<string | null>(null);
  const needsDefault = organizationLoaded && isLoaded && !organization && Boolean(userId);
  const hasNextPage = userMemberships?.hasNextPage ?? false;
  const isFetching = userMemberships?.isFetching ?? false;
  const fetchNext = userMemberships?.fetchNext;
  // The oldest organization can sit on any page, so choose only from the complete list.
  const complete = Boolean(userMemberships) && !hasNextPage && !isFetching && !userMemberships?.isError;
  const memberships = userMemberships?.data;
  const defaultId = complete
    ? pickDefaultOrganizationId(memberships?.map((membership) => membership.organization.id) ?? [])
    : null;

  useEffect(() => {
    if (needsDefault && hasNextPage && !isFetching) fetchNext?.();
  }, [fetchNext, hasNextPage, isFetching, needsDefault]);

  useEffect(() => {
    if (!needsDefault || !setActive || !defaultId) return;
    const attempt = `${userId}:${defaultId}`;
    if (attempted.current === attempt) return;
    attempted.current = attempt;
    void setActive({ organization: defaultId }).catch((error: unknown) => {
      console.warn(
        "[collaboration-organization] default activation failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
  }, [defaultId, needsDefault, setActive, userId]);

  return null;
}

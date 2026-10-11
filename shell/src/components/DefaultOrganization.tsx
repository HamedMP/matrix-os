"use client";

import { useAuth, useOrganization, useOrganizationList } from "@clerk/nextjs";
import { pickDefaultOrganizationId } from "@matrix-os/ui/default-organization";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  OrganizationStateProvider,
  type OrganizationMembershipState,
} from "@/lib/collaboration-organization-state";
import { readOrganizationSelection } from "@/lib/organization-selection";

/**
 * Activates the member's oldest organization when they have none active.
 *
 * Matrix adds people to organizations; members never have to activate one. Clerk
 * leaves the active organization empty until something sets it, so without this every
 * share control would remain in its loading state for a member who belongs to one. A
 * user in no organization is left individual and organization-only UI stays hidden.
 *
 * Mounted once beside the ClerkProvider so it covers every Web view, not only those
 * that render the account menu. Every membership page is loaded first, since the oldest
 * organization can be on any page; switching stays in the account menu
 * (OrganizationMenuItems).
 */
export function DefaultOrganization({ children }: { children?: ReactNode }) {
  const { userId } = useAuth();
  const { isLoaded: organizationLoaded, organization } = useOrganization();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  // One attempt per account and organization: a failed activation must not retry on every
  // render, and the next account in this tab must not inherit the previous one's attempt.
  const attempted = useRef<string | null>(null);
  const [failedActivation, setFailedActivation] = useState<string | null>(null);
  const intentionallyPersonal = readOrganizationSelection(userId ?? null) === "personal";
  const needsDefault = organizationLoaded && isLoaded && !organization && Boolean(userId) && !intentionallyPersonal;
  const hasNextPage = userMemberships?.hasNextPage ?? false;
  const isFetching = userMemberships?.isFetching ?? false;
  const fetchNext = userMemberships?.fetchNext;
  const loadFailed = userMemberships?.isError ?? false;
  // The oldest organization can sit on any page, so choose only from the complete list.
  const complete = Boolean(userMemberships) && !hasNextPage && !isFetching && !loadFailed;
  const memberships = userMemberships?.data;
  const defaultId = complete
    ? pickDefaultOrganizationId(memberships?.map((membership) => membership.organization.id) ?? [])
    : null;
  const activation = userId && defaultId ? `${userId}:${defaultId}` : null;
  const organizationState: OrganizationMembershipState = (() => {
    if (organization?.id) return { status: "member", organizationId: organization.id, organizationName: organization.name };
    if (loadFailed) return { status: "unavailable", organizationId: null };
    if (!userId || !organizationLoaded || !isLoaded || !complete) {
      return { status: "loading", organizationId: null };
    }
    if (intentionallyPersonal) return { status: "none", organizationId: null };
    if ((memberships?.length ?? 0) === 0) return { status: "none", organizationId: null };
    if (failedActivation === activation) return { status: "unavailable", organizationId: null };
    // A membership exists, but Clerk has not finished making the oldest one active.
    return { status: "loading", organizationId: null };
  })();

  // A failed page is not retried here: the default waits for the next load (a reload or the
  // account menu's "More organizations"), so a persistent failure cannot loop requests.
  useEffect(() => {
    if (needsDefault && hasNextPage && !isFetching && !loadFailed) fetchNext?.();
  }, [fetchNext, hasNextPage, isFetching, loadFailed, needsDefault]);

  useEffect(() => {
    if (!needsDefault || !setActive || !defaultId) return;
    const attempt = activation;
    if (!attempt) return;
    if (attempted.current === attempt) return;
    attempted.current = attempt;
    void setActive({ organization: defaultId }).catch((error: unknown) => {
      setFailedActivation(attempt);
      console.warn(
        "[collaboration-organization] default activation failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
  }, [activation, defaultId, needsDefault, setActive]);

  return <OrganizationStateProvider value={organizationState}>{children ?? null}</OrganizationStateProvider>;
}

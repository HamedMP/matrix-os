"use client";

import { useOrganization, useOrganizationList } from "@clerk/nextjs";
import { CheckIcon, UsersIcon } from "@/lib/hugeicons";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

/**
 * Organization picker for the account menu.
 *
 * Sharing exists only inside an organization, and every share control reads the
 * *active* organization through `useOrganization` (see `collaboration-organization.tsx`).
 * Clerk does not activate one on its own, so without a way to choose, those controls
 * render "Join an organization to share" permanently even for a user who belongs to one.
 *
 * Organization administration deliberately stays in the Clerk dashboard per the V1
 * scope decision; this only selects among memberships the user already has, and
 * renders nothing when they have none or when Clerk has not loaded.
 */
export function OrganizationMenuItems({ itemClass }: { itemClass: string }) {
  const { organization } = useOrganization();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const memberships = userMemberships?.data ?? [];
  if (!isLoaded || !setActive || memberships.length === 0) return null;
  return (
    <>
      <div className="mt-1.5 px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
        Organization
      </div>
      {memberships.map((membership) => {
        const active = membership.organization.id === organization?.id;
        return (
          <DropdownMenuPrimitive.Item
            key={membership.organization.id}
            className={itemClass}
            onSelect={() => {
              // Switching remounts every share subtree, which is why
              // CollaborationOrganization is keyed by organization id: no pending
              // preflight token or open scope carries into another organization.
              void setActive({ organization: membership.organization.id }).catch((error: unknown) => {
                console.warn(
                  "[collaboration-organization] activation failed",
                  error instanceof Error ? error.name : "UnknownError",
                );
              });
            }}
          >
            <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{membership.organization.name}</span>
            {active ? <CheckIcon className="size-4 text-muted-foreground" aria-hidden="true" /> : null}
          </DropdownMenuPrimitive.Item>
        );
      })}
    </>
  );
}

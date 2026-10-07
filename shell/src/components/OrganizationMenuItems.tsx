"use client";

import { useOrganization, useOrganizationList } from "@clerk/nextjs";
import { useState } from "react";
import { CheckIcon, UsersIcon } from "@/lib/hugeicons";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

/**
 * Organization picker for the account menu.
 *
 * Sharing exists only inside an organization, and every share control reads the
 * *active* organization through `useOrganization` (see `collaboration-organization.tsx`).
 * Clerk does not activate one on its own, so without a way to choose, those controls
 * remain in their loading state even for a user who belongs to one.
 *
 * Organization administration deliberately stays in the Clerk dashboard per the V1
 * scope decision; this only selects among memberships the user already has, and
 * renders nothing when they have none or when Clerk has not loaded.
 *
 * Selecting keeps the menu open so the outcome is visible where the choice was made:
 * the checked item moves on success, and a failure is announced inline. A menu that
 * closes on click would hide both, leaving a member unable to share with no sign why.
 */
export function OrganizationMenuItems({ itemClass }: { itemClass: string }) {
  const { organization } = useOrganization();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failedName, setFailedName] = useState<string | null>(null);
  const memberships = userMemberships?.data ?? [];
  // A failed membership load is not "no organizations": rendering nothing would leave a
  // member unable to share with no sign why. Show the section so the failure is visible.
  const loadFailed = userMemberships?.isError ?? false;
  if (!isLoaded || !setActive) return null;
  if (memberships.length === 0 && !loadFailed) return null;

  const activate = (organizationId: string, name: string) => {
    setPendingId(organizationId);
    setFailedName(null);
    // Switching remounts every share subtree, which is why CollaborationOrganization
    // is keyed by organization id: no pending preflight token or open scope carries
    // into another organization.
    void setActive({ organization: organizationId }).then(
      () => setPendingId(null),
      (error: unknown) => {
        console.warn(
          "[collaboration-organization] activation failed",
          error instanceof Error ? error.name : "UnknownError",
        );
        setPendingId(null);
        setFailedName(name);
      },
    );
  };

  return (
    <>
      <DropdownMenuPrimitive.Label className="mt-1.5 px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
        Organization
      </DropdownMenuPrimitive.Label>
      {/* menuitemradio + aria-checked, so the active organization is announced, not only drawn. */}
      <DropdownMenuPrimitive.RadioGroup value={organization?.id ?? ""}>
        {memberships.map((membership) => {
          const { id, name } = membership.organization;
          return (
            <DropdownMenuPrimitive.RadioItem
              key={id}
              value={id}
              className={itemClass}
              disabled={pendingId !== null}
              onSelect={(event) => {
                event.preventDefault();
                if (id !== organization?.id) activate(id, name);
              }}
            >
              <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              {pendingId === id ? <span className="text-xs text-muted-foreground">Switching…</span> : null}
              <DropdownMenuPrimitive.ItemIndicator>
                <CheckIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              </DropdownMenuPrimitive.ItemIndicator>
            </DropdownMenuPrimitive.RadioItem>
          );
        })}
      </DropdownMenuPrimitive.RadioGroup>
      {/* Clerk pages memberships; an organization on a later page must still be selectable. */}
      {userMemberships?.hasNextPage ? (
        <DropdownMenuPrimitive.Item
          className={itemClass}
          disabled={userMemberships.isFetching}
          onSelect={(event) => {
            event.preventDefault();
            userMemberships.fetchNext();
          }}
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {userMemberships.isFetching ? "Loading…" : "More organizations"}
          </span>
        </DropdownMenuPrimitive.Item>
      ) : null}
      {failedName ? (
        <p role="alert" className="px-3 py-1.5 text-xs text-destructive">
          Couldn&apos;t switch to {failedName}. Try again.
        </p>
      ) : null}
      {/* "More organizations" stays visible after a failed page load, so it doubles as retry. */}
      {loadFailed ? (
        <p role="alert" className="px-3 py-1.5 text-xs text-destructive">
          {memberships.length > 0 ? "Couldn't load more organizations. Try again." : "Couldn't load your organizations."}
        </p>
      ) : null}
    </>
  );
}

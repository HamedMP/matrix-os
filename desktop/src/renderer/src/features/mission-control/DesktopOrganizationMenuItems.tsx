import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CheckIcon, UsersIcon } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod/v4";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

const OrganizationsResponseSchema = z.object({
  organizations: z.array(z.object({
    organizationId: z.string().regex(/^org_[A-Za-z0-9_-]{1,124}$/),
    name: z.string().max(256),
  })).max(100),
});

type Organization = z.infer<typeof OrganizationsResponseSchema>["organizations"][number];
type Listing = { state: "loading" } | { state: "loaded"; organizations: Organization[] } | { state: "failed" };

/**
 * Electron Desktop counterpart of the shell's OrganizationMenuItems.
 *
 * Every share control on Electron Desktop reads `organizationId` from the connection
 * store, and the trusted-core auth status never carries one -- so before this, all of
 * them read "Join an organization to share" permanently. Choosing here sets it and the
 * store remembers it per user.
 *
 * Organizations come from the platform's membership projection, not Clerk's browser
 * SDK (Electron has no Clerk session). The platform caps the listing at 100, so one
 * request returns every membership and there is no next page to fetch.
 *
 * Mounted inside the open menu: each open re-reads membership, and the API is released
 * on close rather than left in the shared live-API set.
 */
export function DesktopOrganizationMenuItems({ itemClass }: { itemClass: string }) {
  const platformHost = useConnection((state) => state.platformHost);
  const userId = useConnection((state) => state.userId);
  const organizationId = useConnection((state) => state.organizationId);
  const selectOrganization = useConnection((state) => state.selectOrganization);
  const api = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const [listing, setListing] = useState<Listing>({ state: "loading" });

  useEffect(() => () => { if (api) releaseDesktopCollaborationApi(api); }, [api]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- membership is read when the account menu opens, not on a user event; the request is ignored after unmount.
  useEffect(() => {
    let active = true;
    if (!api || !userId) return () => { active = false; };
    void api.get("/api/organizations").then((value) => {
      if (!active) return;
      const { organizations } = OrganizationsResponseSchema.parse(value);
      setListing({ state: "loaded", organizations });
    }).catch((error: unknown) => {
      console.warn("[collaboration-organization] organizations unavailable", error instanceof Error ? error.name : "UnknownError");
      if (active) setListing({ state: "failed" });
    });
    return () => { active = false; };
  }, [api, userId]);

  // A remembered organization the member has since left must not stay selected.
  useEffect(() => {
    if (listing.state !== "loaded" || !organizationId) return;
    if (!listing.organizations.some((organization) => organization.organizationId === organizationId)) {
      selectOrganization(null);
    }
  }, [listing, organizationId, selectOrganization]);

  if (listing.state === "loading") return null;
  if (listing.state === "loaded" && listing.organizations.length === 0) return null;

  return (
    <>
      <DropdownMenu.Label className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: "var(--text-tertiary)" }}>
        Organization
      </DropdownMenu.Label>
      {listing.state === "loaded" ? (
        // menuitemradio + aria-checked, so the active organization is announced, not only drawn.
        <DropdownMenu.RadioGroup value={organizationId ?? ""}>
          {listing.organizations.map((organization) => (
            <DropdownMenu.RadioItem
              key={organization.organizationId}
              value={organization.organizationId}
              className={itemClass}
              style={{ color: "var(--text-primary)" }}
              onSelect={(event) => {
                // Keep the menu open so the moved checkmark is visible where the choice was made.
                event.preventDefault();
                selectOrganization(organization.organizationId);
              }}
            >
              <span aria-hidden="true" style={{ color: "var(--text-tertiary)" }}><UsersIcon size={14} /></span>
              <span className="min-w-0 flex-1 truncate">{organization.name}</span>
              <DropdownMenu.ItemIndicator>
                <CheckIcon aria-hidden="true" size={14} style={{ color: "var(--text-tertiary)" }} />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      ) : (
        <p role="alert" className="px-2 py-1.5 text-[12px]" style={{ color: "var(--danger)" }}>
          Couldn&apos;t load your organizations.
        </p>
      )}
      <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
    </>
  );
}

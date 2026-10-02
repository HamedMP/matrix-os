import { useEffect, useState } from "react";
import { z } from "zod/v4";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

// The platform caps the listing here. A full page cannot prove an organization is absent.
const LISTING_CAP = 100;

const OrganizationsResponseSchema = z.object({
  organizations: z.array(z.object({
    organizationId: z.string().regex(/^org_[A-Za-z0-9_-]{1,124}$/),
    name: z.string().max(256),
  })).max(LISTING_CAP),
});

export type DesktopOrganization = z.infer<typeof OrganizationsResponseSchema>["organizations"][number];
export type DesktopOrganizationListing =
  | { state: "loading" }
  | { state: "loaded"; organizations: DesktopOrganization[] }
  | { state: "failed" };

/**
 * Reads the member's organizations from the platform's membership projection (Electron
 * has no Clerk session) and reconciles the active one with it: the member's choice is
 * kept while they still belong to it, otherwise their oldest organization becomes
 * active, and a user in no organization stays individual.
 *
 * Reconciling once per response -- never from an effect that watches the selection --
 * keeps two listings read at different times from undoing each other. The listing is
 * tagged with the account it was requested for, so an account switch mid-request
 * cannot apply one user's memberships to the next.
 */
export function useDesktopOrganizations(): DesktopOrganizationListing {
  const platformHost = useConnection((state) => state.platformHost);
  const userId = useConnection((state) => state.userId);
  const reconcileOrganizations = useConnection((state) => state.reconcileOrganizations);
  const beginOrganizationListing = useConnection((state) => state.beginOrganizationListing);
  const [listing, setListing] = useState<DesktopOrganizationListing>({ state: "loading" });

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- membership is read at sign-in and when the account menu opens, not on a user event; the response is ignored after unmount or an account switch.
  useEffect(() => {
    if (!userId) return;
    // One API per request, released as soon as it settles: this runs for the whole
    // signed-in session, and must not hold a live direct session slot it never uses.
    const api = createDesktopCollaborationApi(platformHost);
    if (!api) return;
    let active = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseDesktopCollaborationApi(api);
    };
    setListing({ state: "loading" });
    const request = beginOrganizationListing();
    void api.get("/api/organizations").then((value) => {
      if (!active) return;
      const { organizations } = OrganizationsResponseSchema.parse(value);
      setListing({ state: "loaded", organizations });
      reconcileOrganizations({
        request,
        forUserId: userId,
        organizationIds: organizations.map((organization) => organization.organizationId),
        complete: organizations.length < LISTING_CAP,
      });
    }).catch((error: unknown) => {
      console.warn("[collaboration-organization] organizations unavailable", error instanceof Error ? error.name : "UnknownError");
      if (active) setListing({ state: "failed" });
    }).finally(release);
    return () => {
      active = false;
      release();
    };
  }, [beginOrganizationListing, platformHost, reconcileOrganizations, userId]);

  return listing;
}

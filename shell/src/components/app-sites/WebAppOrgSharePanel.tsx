"use client";

import { useState, type ReactNode } from "react";
import { shellApi } from "@/api/http";
import { cn } from "@/lib/utils";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";
import { useOwnerCollaborationParticipant } from "@/lib/owner-collaboration-participant";
import { notifyOwnerAppSharing } from "@/lib/owner-app-sharing-events";
import { useShellOrganizations } from "@/components/organization/useShellOrganizations";
import { useShellOrganizationDirectory } from "@/components/organization/useShellOrganizationDirectory";
import { Button } from "../ui/button";
import type { SiteClient } from "../../lib/site-client";
import { AppSiteSharePanel } from "./AppSiteSharePanel";
import { useAppOrgSharing, type AppOrgListing } from "./app-org-sharing";
import { AppOrgSharingDetails, AppOrgSharingSummary, type AppOrgShareButton } from "./AppOrgSharingSection";
import { AppOrgMemberRoster } from "./AppOrgMemberRoster";

const NO_ORGANIZATIONS: AppOrgListing = { state: "loaded", organizations: [] };

const WebShareButton: AppOrgShareButton = ({ tone, className, ...props }) => (
  <Button size="sm" variant={tone === "primary" ? "default" : "outline"} className={cn("h-7 px-2.5 text-xs", className)} {...props} />
);

function WebOrganizationMemberList({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const participant = useOwnerCollaborationParticipant();
  const [retryKey, setRetryKey] = useState(0);
  const directory = useShellOrganizationDirectory(organizationId, false, retryKey);
  return <AppOrgMemberRoster directory={directory} organizationName={organizationName}
    currentActorId={participant?.actorId ?? null} onRetry={() => setRetryKey((key) => key + 1)} Button={WebShareButton} />;
}

/** The membership listing needs Clerk; a shell without an organization context (self-hosted) has none to list. */
function ClerkOrganizationListing({ children }: { children: (listing: AppOrgListing) => ReactNode }) {
  return children(useShellOrganizations());
}

type PanelProps = { appSlug: string; client: SiteClient; ownerIdentity: string; buildEpoch: number; onClose: () => void };

function WebOrgSharingPanel({ listing, buildEpoch, ...panel }: PanelProps & { listing: AppOrgListing }) {
  const organization = useCollaborationOrganization();
  const controller = useAppOrgSharing({
    appId: panel.appSlug,
    api: shellApi,
    buildEpoch,
    organizations: {
      selectedOrganizationId: organization.organizationId,
      selectedOrganizationName: organization.organizationName ?? null,
      status: organization.status,
      listing,
    },
    onShareChanged: () => notifyOwnerAppSharing(panel.appSlug, "share-changed"),
  });
  const { organizationId, organizationName } = controller;
  return <AppSiteSharePanel {...panel} organizationSharing={{
    summary: <AppOrgSharingSummary controller={controller} />,
    title: "Organization sharing",
    content: <AppOrgSharingDetails controller={controller} Button={WebShareButton} members={organizationId ? (
      <WebOrganizationMemberList organizationId={organizationId} organizationName={organizationName ?? "your organization"} />
    ) : null} />,
  }} />;
}

/** Web's Publish app popover content: invite, publication, and organization sharing in one place. */
export function WebAppOrgSharePanel(props: PanelProps) {
  const organization = useCollaborationOrganization();
  // Only a resolved Clerk organization state can be listed; self-hosted and loading shells name the selection alone.
  if (organization.status !== "member" && organization.status !== "unavailable") {
    return <WebOrgSharingPanel {...props} listing={NO_ORGANIZATIONS} />;
  }
  return <ClerkOrganizationListing>{(listing) => <WebOrgSharingPanel {...props} listing={listing} />}</ClerkOrganizationListing>;
}

import type { OrganizationManagementRole } from "@matrix-os/contracts";

export interface OrganizationMemberProfile {
  actorId: string;
  displayName: string;
  emailAddress?: string;
}

export interface OrganizationPendingInvitation {
  invitationId: string;
  emailAddress: string;
  role: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface OrganizationManagementDirectory {
  resolveMemberProfiles(actorIds: readonly string[]): Promise<Map<string, OrganizationMemberProfile>>;
}

export interface OrganizationManagementUpstream {
  listPendingInvitations(organizationId: string): Promise<OrganizationPendingInvitation[]>;
  renameOrganization(organizationId: string, name: string): Promise<void>;
  updateOrganizationLogo(organizationId: string, logo: Blob): Promise<void>;
  createInvitations(organizationId: string, emailAddresses: readonly string[], role: OrganizationManagementRole): Promise<void>;
  resendInvitation(organizationId: string, invitationId: string): Promise<void>;
  revokeInvitation(organizationId: string, invitationId: string): Promise<void>;
  updateMemberRole(organizationId: string, actorId: string, role: OrganizationManagementRole): Promise<void>;
  removeMember(organizationId: string, actorId: string): Promise<void>;
  deleteOrganization(organizationId: string): Promise<void>;
}

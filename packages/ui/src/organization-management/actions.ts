import {
  OrganizationManagementMutationResultSchema,
  type OrganizationManagementRole,
} from "@matrix-os/contracts";
import type { CollaborationApi } from "../collaboration/ChatCollaboratorsDialog.js";

export interface OrganizationManagementActions {
  rename(name: string): Promise<void>;
  updateLogo(file: Blob, fileName?: string): Promise<void>;
  invite(emailAddresses: string[], role: OrganizationManagementRole): Promise<void>;
  updateRole(actorId: string, role: OrganizationManagementRole): Promise<void>;
  removeMember(actorId: string): Promise<void>;
  resendInvitation(invitationId: string): Promise<void>;
  revokeInvitation(invitationId: string): Promise<void>;
  deleteOrganization(): Promise<void>;
}

export function createOrganizationManagementActions(
  api: CollaborationApi,
  organizationId: string,
): OrganizationManagementActions {
  const organization = `/api/organizations/${encodeURIComponent(organizationId)}`;
  const complete = async (request: Promise<unknown>) => {
    OrganizationManagementMutationResultSchema.parse(await request);
  };
  return {
    rename: (name) => complete(api.patch!(organization, { name })),
    updateLogo: (file, fileName = "logo") => {
      const form = new FormData();
      form.set("file", file, fileName);
      return complete(api.patch!(`${organization}/logo`, form));
    },
    invite: (emailAddresses, role) => complete(api.post(`${organization}/invitations`, { emailAddresses, role })),
    updateRole: (actorId, role) => complete(api.patch!(`${organization}/members/${encodeURIComponent(actorId)}`, { role })),
    removeMember: (actorId) => complete(api.delete(`${organization}/members/${encodeURIComponent(actorId)}`)),
    resendInvitation: (invitationId) => complete(api.post(`${organization}/invitations/${encodeURIComponent(invitationId)}/resend`, {})),
    revokeInvitation: (invitationId) => complete(api.delete(`${organization}/invitations/${encodeURIComponent(invitationId)}`)),
    deleteOrganization: () => complete(api.delete(organization)),
  };
}

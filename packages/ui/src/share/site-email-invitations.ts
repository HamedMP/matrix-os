import type {
  SiteEmailInvitationPage, SiteEmailInvitationInputResult, SiteEmailInvitationSummary, SiteEmailInvitationsCapability,
} from "@matrix-os/contracts";
import type { LiveEmailInvitationAdapter } from "./email-invitations";

/** Structural boundary shared by the Web and runtime-bound Electron clients. */
export interface SiteEmailInvitationClient {
  emailInvitationCapabilities?(app: string, signal: AbortSignal): Promise<SiteEmailInvitationsCapability>;
  emailInvitations(app: string, signal: AbortSignal, cursor?: string | null): Promise<SiteEmailInvitationPage>;
  createEmailInvitations(app: string, value: { baseRevision: number; emailAddresses: string[] }, signal: AbortSignal): Promise<{ results: SiteEmailInvitationInputResult[]; siteRevision: number }>;
  resendEmailInvitation(app: string, id: string, value: { baseRevision: number; invitationRevision: number }, signal: AbortSignal): Promise<{ invitation: SiteEmailInvitationSummary; siteRevision: number }>;
  revokeEmailInvitation(app: string, id: string, value: { baseRevision: number; invitationRevision: number }, signal: AbortSignal): Promise<{ invitation: SiteEmailInvitationSummary; siteRevision: number }>;
}

/** No local grants, mode cache, or mail delivery: all authority stays server-side. */
export function createSiteEmailInvitationAdapter(client: SiteEmailInvitationClient): LiveEmailInvitationAdapter {
  return {
    kind: "live",
    available: async (app, signal) => (await client.emailInvitationCapabilities?.(app, signal))?.privateEmailInvitations === true,
    list: (app, signal, cursor) => client.emailInvitations(app, signal, cursor),
    invite: (app, value, signal) => client.createEmailInvitations(app, value, signal),
    resend: (app, id, value, signal) => client.resendEmailInvitation(app, id, value, signal),
    revoke: (app, id, value, signal) => client.revokeEmailInvitation(app, id, value, signal),
  };
}

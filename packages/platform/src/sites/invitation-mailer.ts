import { SiteIdSchema } from '@matrix-os/contracts';

export interface SiteInvitationMail {
  idempotencyKey: string;
  invitationId: string;
  generation: number;
  email: string;
  siteId: string;
  url: string;
  title: string;
  expiresAt: Date;
}
export type SiteInvitationMailResult =
  | { kind: 'sent'; messageId?: string }
  | { kind: 'retryable' | 'ambiguous' | 'permanent' };
/** Adapter must use one reviewed platform sender and a fixed provider origin. */
export interface SiteInvitationMailer {
  send(input: SiteInvitationMail, signal: AbortSignal): Promise<SiteInvitationMailResult>;
}

const escape = (value: string) => value.replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** URL possession never grants access; the same Matrix Clerk identity is checked on arrival. */
export function renderSiteInvitationMail(input: SiteInvitationMail) {
  const url = `https://matrix.page/${SiteIdSchema.parse(input.siteId)}`;
  const title = input.title.slice(0, 200);
  const subject = 'You are invited to a Matrix app';
  return {
    subject,
    text: `You have been invited to view ${title}. Open ${url} and sign in with the invited email address. This invitation expires in seven days.`,
    html: `<p>You have been invited to view ${escape(title)}.</p><p><a href="${url}">Open shared app</a> and sign in with the invited email address.</p><p>This invitation expires in seven days.</p>`,
  };
}

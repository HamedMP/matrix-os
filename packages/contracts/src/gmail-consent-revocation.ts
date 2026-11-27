import { z } from 'zod/v4';

export const GMAIL_HOSTED_REVOCATION_PROOF_HEADER = 'x-matrix-gmail-revocation-proof';
export const GmailHostedRevocationReceiptSchema = z.strictObject({
  nonce: z.uuid(),
  expiresAt: z.number().int().positive(),
});
export type GmailHostedRevocationReceipt = z.infer<typeof GmailHostedRevocationReceiptSchema>;

export function gmailConsentRevocationAccount(method: string, path: string, routePrefix: string): string | undefined {
  const prefix = `${routePrefix}/gmail/processing-consents/`;
  if (method !== 'DELETE' || !path.startsWith(prefix)) return undefined;
  return z.uuid().safeParse(path.slice(prefix.length)).data;
}

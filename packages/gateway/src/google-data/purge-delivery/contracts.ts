import { z } from 'zod/v4';
import { GoogleDataConsentInputSchema } from '../profiles.js';
export const PurgeOwnerSchema = GoogleDataConsentInputSchema.shape.ownerId;
export const GooglePurgeCommandSchema = z.strictObject({ commandId:z.uuid(), ownerId:PurgeOwnerSchema,
  googleAccountId:z.uuid(), consentId:z.uuid(), originId:z.string().regex(/^[a-f0-9]{64}$/),
  revision:z.number().int().positive().max(2147483646), leaseToken:z.uuid(),leaseUntil:z.iso.datetime() });
export const GooglePurgePollSchema = z.strictObject({});
export const GooglePurgeReceiptSchema = z.strictObject({ coverage:z.literal('registered-copies-only'),complete:z.literal(true),
  pending:z.literal(0),unresolved:z.literal(0),requestIds:z.array(z.uuid()).max(1000).refine(ids=>new Set(ids).size===ids.length) });
export const GooglePurgeAckSchema = GooglePurgeCommandSchema.pick({commandId:true,revision:true,leaseToken:true})
  .extend({receipt:GooglePurgeReceiptSchema});
export const GooglePurgeCommandsSchema = z.strictObject({commands:z.array(GooglePurgeCommandSchema).max(20)});
export const GooglePurgeAckedSchema = z.strictObject({acknowledged:z.literal(true)});
export type GooglePurgeCommand = z.infer<typeof GooglePurgeCommandSchema>;
export type GooglePurgeAck = z.infer<typeof GooglePurgeAckSchema>;

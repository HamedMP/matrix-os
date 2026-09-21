import { z } from 'zod/v4';
import { DeveloperToolsWithDefaultSchema } from '../developer-tools.js';
import { HetznerServerTypeSchema, RuntimeSlotSchema } from '../customer-vps-schema.js';
import { resolveReturnPath } from '../origins.js';
import { isSafeMarketingLandingPath } from '../reddit-purchase-attribution.js';

/** Extracted verbatim from packages/platform/src/billing-routes.ts (S01 / T007): checkout and portal request schemas. */

export const MATRIX_CARD_TRIAL_DAYS = 3;

export const MatrixCardTrialDaysSchema = z.string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(30));

export const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9]{1,128}$/;

export const CheckoutBillingRegionSlugSchema = z.enum([
  'region_fsn1',
  'region_nbg1',
  'region_ash',
  'region_hil',
]);

export const HistoricalBillingRegionSlugSchema = z.enum([
  'region_fsn1',
  'region_nbg1',
  'region_ash',
  'region_hil',
]);

export const MarketingAttributionSchema = z.object({
  rdt_cid: z.string().min(1).max(256).optional(),
  utm_source: z.string().min(1).max(256).optional(),
  utm_medium: z.string().min(1).max(256).optional(),
  utm_campaign: z.string().min(1).max(256).optional(),
  utm_content: z.string().min(1).max(256).optional(),
  utm_term: z.string().min(1).max(256).optional(),
  landing_path: z.string().min(1).max(512).refine(
    (value) => isSafeMarketingLandingPath(value),
    { message: 'Invalid marketing landing path' },
  ).optional(),
}).strict();

export type MarketingAttribution = z.infer<typeof MarketingAttributionSchema>;

export const CheckoutRequestSchema = z.object({
  planSlug: z.enum(['matrix_starter', 'matrix_builder', 'matrix_max']),
  interval: z.literal('monthly').default('monthly'),
  regionSlug: CheckoutBillingRegionSlugSchema.default('region_fsn1'),
  serverType: HetznerServerTypeSchema.optional(),
  developerTools: DeveloperToolsWithDefaultSchema,
  runtimeSlot: RuntimeSlotSchema.optional().default('primary'),
  attribution: MarketingAttributionSchema.optional(),
  returnPath: z.string().min(1).max(2048).optional().refine(
    // Safe iff it is already a same-origin allowlisted path (origins.ts is the
    // single source of truth for redirect-target validation).
    (value) => value === undefined || resolveReturnPath(value) === value,
    { message: 'Invalid return path' },
  ),
});

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

export const PortalRequestSchema = z.object({
  intent: z.literal('manage').default('manage'),
  returnPath: z.string().min(1).max(2048).optional().refine(
    (value) => value === undefined || resolveReturnPath(value) === value,
    { message: 'Invalid return path' },
  ),
}).strict();

export const CheckoutPreparationStatusQuerySchema = z.object({
  attemptId: z.uuid(),
}).strict();

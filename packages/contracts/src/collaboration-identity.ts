import { z } from "zod/v4";
/** Clerk organization identifier: every scope is owned by exactly one organization (S20 / T101). */
export const CollaborationOrganizationIdSchema = z.string()
    .min(5)
    .max(128)
    .regex(/^org_[A-Za-z0-9_-]+$/, "Invalid organization identifier");

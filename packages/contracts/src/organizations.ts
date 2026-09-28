import { z } from "zod/v4";

export const OrganizationCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(100).refine((name) => !/[\u0000-\u001f\u007f-\u009f]/u.test(name)),
  clientRequestId: z.uuid(),
}).strict();

export const OrganizationCreateResponseSchema = z.object({
  organizationId: z.string().regex(/^org_[A-Za-z0-9]{1,124}$/).optional(),
  name: z.string().min(1).max(100),
  state: z.enum(["listed", "setting_up"]),
}).strict();

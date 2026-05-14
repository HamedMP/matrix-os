import { z } from "zod/v4";

export const TicketAutomationRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  trigger: z.object({
    type: z.literal("ticket.status.changed"),
    statuses: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  }).strict(),
  action: z.object({
    type: z.literal("assign_to_symphony"),
    runtimeMode: z.literal("cloud"),
  }).strict(),
}).strict();

export type TicketAutomationRuleInput = z.infer<typeof TicketAutomationRuleSchema>;

export interface TicketAutomationRule extends TicketAutomationRuleInput {
  id: string;
  ownerId: string;
  projectSlug: string;
  enabled: boolean;
}

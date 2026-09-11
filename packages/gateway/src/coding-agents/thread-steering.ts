import { z } from "zod/v4";
import { AgentTurnIdSchema, CreateAgentTurnRequestSchema, RequestIdSchema } from "@matrix-os/contracts";

export const CodingAgentSteerRequestSchema = z.object({
  expectedTurnId: AgentTurnIdSchema.optional(),
  message: CreateAgentTurnRequestSchema.shape.message,
  clientRequestId: RequestIdSchema,
}).strict();

/** Dispatch completion is not completion of a background provider's turn. */
export function matchesSteeringTurn(
  thread: { activeTurnId?: string; deliveredTurnId?: string },
  expectedTurnId: string | undefined,
): boolean {
  // A newly admitted dispatch always fences the previously delivered turn.
  return (thread.activeTurnId ?? thread.deliveredTurnId) === expectedTurnId;
}

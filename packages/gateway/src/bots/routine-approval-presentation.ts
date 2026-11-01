import { BotRoutineProposalSchema, type BotInteraction } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { RoutineAuthorizationSchema } from "./routine-authorization.js";
import { nextBotRoutineFire } from "./routine-schedule.js";

const envelope = z.object({ proposal: BotRoutineProposalSchema, source: RoutineAuthorizationSchema }).strict();
/** Display estimate only. Persisted approval/digest are untouched and checked again on confirmation. */
export function presentRoutineApproval(payload: BotInteraction["payload"]): BotInteraction["payload"] {
  if (payload?.kind !== "approval" || payload.tool !== "routine.activate") return payload;
  let value: unknown;
  try { value = JSON.parse(payload.preview); }
  catch (error: unknown) { if (error instanceof SyntaxError) return payload; throw error; }
  const parsed = envelope.safeParse(value);
  if (!parsed.success) return payload;
  let estimatedNextFireAt: string | null;
  try { estimatedNextFireAt = nextBotRoutineFire(parsed.data.proposal.schedule, new Date().toISOString()); }
  catch (error: unknown) {
    // A malformed proposed schedule remains visible for denial; it cannot activate.
    console.warn("[bots] Routine display estimate unavailable:", error instanceof Error ? error.name : "UnknownError");
    return payload;
  }
  const preview = JSON.stringify({ ...parsed.data, estimatedNextFireAt });
  if (Buffer.byteLength(preview) > 32768) return payload;
  return { ...payload, preview };
}

import { ROUTINE_DESTINATION_PATH, RoutineDestinationViewSchema, RoutineCliRememberTargetSchema, RoutineCliResetTargetSchema } from "@matrix-os/contracts/routine-destination";
import { gatewayRequestUrl, fetchAuthenticatedAnswer } from "./answers";
/** Only fixed app-written error copy reaches the shared hook; server/provider messages never do. */
export class RoutineDestinationRequestError extends Error {
  constructor(readonly status: number | null) { super("Routine destination unavailable."); this.name = "RoutineDestinationRequestError"; }
}
export async function requestRoutineDestination(token: string, gatewayUrl: string, kind: "get" | "remember" | "reset", input?: unknown, signal?: AbortSignal) {
  const path = ROUTINE_DESTINATION_PATH + (kind === "reset" ? "/reset" : ""), url = gatewayRequestUrl(gatewayUrl, path);
  if (!url || signal?.aborted) throw new RoutineDestinationRequestError(null);
  const body = kind === "get" ? undefined : kind === "remember" ? RoutineCliRememberTargetSchema.parse(input) : RoutineCliResetTargetSchema.parse(input);
  try {
    const answer = await fetchAuthenticatedAnswer({ url, token, schema: RoutineDestinationViewSchema, refusalStatuses: [409],
      errorMessage: "Routine destination unavailable.", method: kind === "get" ? "GET" : "POST", signal,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!answer.ok) throw new RoutineDestinationRequestError(answer.status);
    return answer.value;
  } catch (error: unknown) {
    if (error instanceof RoutineDestinationRequestError) throw error;
    console.warn("[mobile] Routine destination unavailable", error instanceof Error ? error.name : "UnknownError"); throw new RoutineDestinationRequestError(null);
  }
}

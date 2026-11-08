import { createOwnerBrowserJsonRequest } from "./owner-browser-request.js";
import { z } from "zod/v4";
import { ROUTINE_ACTION_PATH, RoutineActionIdSchema, RoutineActionViewSchema, RoutineActionSubmitSchema,
  type RoutineActionSubmit } from "@matrix-os/contracts";

const MAX_INBOX_CHALLENGES = 128;
const MAX_CHALLENGE_RESPONSE_BYTES = 128 * 1024;
// A serialized proposal is bounded at 20 KiB, plus room for escaped labels and the envelope.
const MAX_INBOX_RESPONSE_BYTES = MAX_INBOX_CHALLENGES * 24 * 1024;

export function routineActionResponseByteLimit(method: "GET" | "POST", path: string): number {
  return method === "GET" && path === ROUTINE_ACTION_PATH ? MAX_INBOX_RESPONSE_BYTES : MAX_CHALLENGE_RESPONSE_BYTES;
}

export type RoutineActionRequest = (input: { path: string; method: "GET" | "POST"; body?: RoutineActionSubmit; signal: AbortSignal }) => Promise<unknown>;
export function createRoutineActionClient(request: RoutineActionRequest) {
  if (typeof request !== "function") throw new Error("Routine confirmation unavailable");
  return {
    read: async (id: string, signal: AbortSignal) => RoutineActionViewSchema.parse(await request({ path: `${ROUTINE_ACTION_PATH}/${RoutineActionIdSchema.parse(id)}`, method: "GET", signal })),
    list: async (signal: AbortSignal) => z.strictObject({ challenges: z.array(RoutineActionViewSchema).max(MAX_INBOX_CHALLENGES) }).parse(await request({ path: ROUTINE_ACTION_PATH, method: "GET", signal })).challenges,
    submit: async (id: string, body: RoutineActionSubmit, signal: AbortSignal) => z.strictObject({ submission: z.enum(["accepted", "already_submitted"]) }).parse(await request({
      path: `${ROUTINE_ACTION_PATH}/${RoutineActionIdSchema.parse(id)}/decision`, method: "POST", body: RoutineActionSubmitSchema.parse(body), signal,
    })),
  };
}
export type RoutineActionClient = ReturnType<typeof createRoutineActionClient>;
/** Browser adapter with bounded body/timeout. Credentials are normal owner routing only; Platform supplies the stronger proof. */
export function createRoutineActionBrowserClient(gatewayUrl: string, getToken: () => Promise<string | null>, fetcher: typeof fetch = fetch) {
  return createRoutineActionClient(createOwnerBrowserJsonRequest(gatewayUrl, getToken, fetcher, {
    responseLimit: input => routineActionResponseByteLimit(input.method, input.path),
  }));
}

import { createOwnerBrowserJsonRequest } from "./owner-browser-request.js";
import {
  CanonicalChatIdSchema, RoutineFullAccessCreateChallengeSchema, RoutineFullAccessDecisionSubmitSchema,
  RoutineFullAccessIdSchema, RoutineFullAccessRevokeSchema, RoutineFullAccessStatusSchema,
  ROUTINE_FULL_ACCESS_SCOPE_HEADER, type CanonicalCreateChatTurnRequest,
  type RoutineFullAccessDecisionSubmit,
} from "@matrix-os/contracts";

export type RoutineFullAccessRequest = (input: {
  path: string; method: "GET" | "POST"; body?: unknown; signal?: AbortSignal;
}) => Promise<unknown>;
const path = (chatId: string) => `/api/chats/${encodeURIComponent(CanonicalChatIdSchema.parse(chatId))}/routine-cli/full-access`;
/** Scope references are selectors only. All decisions and origin proofs remain server-owned. */
export function createRoutineFullAccessClient(request: RoutineFullAccessRequest) {
  return {
    read: async (chatId: string, signal?: AbortSignal) => RoutineFullAccessStatusSchema.parse(await request({ path: path(chatId), method: "GET", signal })),
    challenge: async (chatId: string, baseRevision: number, signal?: AbortSignal) => RoutineFullAccessStatusSchema.parse(await request({
      path: `${path(chatId)}/challenges`, method: "POST", body: RoutineFullAccessCreateChallengeSchema.parse({ baseRevision }), signal,
    })),
    decide: async (chatId: string, challengeId: string, decision: RoutineFullAccessDecisionSubmit, signal?: AbortSignal) => RoutineFullAccessStatusSchema.parse(await request({
      path: `${path(chatId)}/challenges/${RoutineFullAccessIdSchema.parse(challengeId)}/decision`, method: "POST", body: RoutineFullAccessDecisionSubmitSchema.parse(decision), signal,
    })),
    revoke: async (chatId: string, baseRevision: number, signal?: AbortSignal) => RoutineFullAccessStatusSchema.parse(await request({
      path: `${path(chatId)}/revoke`, method: "POST", body: RoutineFullAccessRevokeSchema.parse({ baseRevision }), signal,
    })),
  };
}
export type RoutineFullAccessClient = ReturnType<typeof createRoutineFullAccessClient>;
export function createRoutineFullAccessBrowserClient(gatewayUrl: string, fetcher: typeof fetch = fetch, getToken: () => Promise<string | null> = async () => null) {
  return createRoutineFullAccessClient(createOwnerBrowserJsonRequest(gatewayUrl, getToken, fetcher, { cache: "no-store", allowRelative: true }));
}

/** Only the Web fresh-turn path calls this; queues/retries/device turns never gain browser provenance. */
export async function routineFullAccessTurnHeaders(client: RoutineFullAccessClient, chatId: string, input: CanonicalCreateChatTurnRequest,
  isCurrent: () => boolean = () => true): Promise<Record<string, string>> {
  if (input.permissionMode !== "full_access" || input.interactionMode !== "default") return {};
  if (!isCurrent()) throw new Error("Chat context changed");
  let status;
  try { status = await client.read(chatId); }
  catch (error: unknown) {
    console.warn("[routine-full-access] Scope read unavailable", error instanceof Error ? error.name : "UnknownError");
    if (!isCurrent()) throw new Error("Chat context changed");
    return {};
  }
  if (!isCurrent()) throw new Error("Chat context changed");
  return status.eligibility === "eligible" && status.consent && Date.parse(status.consent.expiresAt) > Date.now()
    ? { [ROUTINE_FULL_ACCESS_SCOPE_HEADER]: status.consent.scopeId } : {};
}

export function routineFullAccessOwnerUrl(appOrigin: string, gatewayPath: string, chatId: string): string {
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || !/^\/vm\/[a-z0-9][a-z0-9-]{0,62}(?:\?[^#\s]*)?$/.test(gatewayPath)) throw new Error("Routine CLI access unavailable");
  const url = new URL(gatewayPath, origin);
  if (url.origin !== origin.origin || !/^\/vm\/[a-z0-9][a-z0-9-]{0,62}$/.test(url.pathname) || url.hash
    || [...url.searchParams.keys()].some(key => key !== "runtime") || url.searchParams.getAll("runtime").length > 1
    || url.searchParams.has("runtime") && !/^[A-Za-z0-9_-]{1,32}$/.test(url.searchParams.get("runtime")!)) throw new Error("Routine CLI access unavailable");
  url.pathname += "/routine-cli/full-access";
  url.searchParams.set("chat", CanonicalChatIdSchema.parse(chatId));
  return url.toString();
}

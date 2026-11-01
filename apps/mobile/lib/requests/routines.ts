import { z } from "zod/v4";
import { createBotRoutineClient } from "@matrix-os/ui/bot-routine-client";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "./http";
import type { GatewaySession } from "../queries/use-active-gateway";

/** Reuse the exact validated web client contract through the native authenticated transport. */
export function createNativeRoutineClient(session: () => Promise<GatewaySession | null>) {
  return createBotRoutineClient(async (path, method, body) => {
    const auth = await session();
    if (!auth) throw new Error("Schedules are temporarily unavailable.");
    const [pathname, query] = path.split("?");
    const url = new URL(buildGatewayRequestUrl(auth.gatewayUrl, pathname!));
    for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
    return fetchAuthenticatedJson({ url: url.toString(), token: auth.token, method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      schema: z.unknown(), errorMessage: "Schedules are temporarily unavailable." });
  });
}

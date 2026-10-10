import { z } from "zod/v4";

export const UTILITIES_CLOSE_BRIDGE_ARG = "--matrix-utilities-close-bridge";
export const UTILITIES_CLOSE_REQUEST = "native-app:utilities-close-request";
export const UTILITIES_CLOSE_REPLY = "native-app:utilities-close-reply";
export const UTILITIES_CLOSE_READY = "native-app:utilities-close-ready";
export const UtilitiesCloseReadySchema = z.strictObject({ ready: z.boolean() });
export const UtilitiesCloseRequestSchema = z.strictObject({ requestId: z.uuid(), type: z.enum(["request", "cancel"]) });
export const UtilitiesCloseReplySchema = z.strictObject({ requestId: z.uuid(), allow: z.boolean() });
export type UtilitiesCloseRequest = z.infer<typeof UtilitiesCloseRequestSchema>;

export function createUtilitiesCloseClient(
  invoke: (reply: z.infer<typeof UtilitiesCloseReplySchema>) => Promise<unknown>,
  subscribe: (listener: (payload: unknown) => void) => () => void,
  markReady: (ready: boolean) => Promise<unknown>,
) {
  return Object.freeze({
    onCloseRequest(listener: (request: UtilitiesCloseRequest) => void) {
      const off = subscribe(payload => {
        const result = UtilitiesCloseRequestSchema.safeParse(payload);
        if (result.success) listener(result.data);
      });
      const report = (ready: boolean) => { void markReady(ready).catch((error: unknown) => {
        console.warn("[utilities-close] readiness unavailable", error instanceof Error ? "Error" : "UnknownError");
      }); };
      report(true);
      return () => { off(); report(false); };
    },
    respondToClose(requestId: string, allow: boolean) {
      const reply = UtilitiesCloseReplySchema.parse({ requestId, allow });
      return invoke(reply);
    },
  });
}

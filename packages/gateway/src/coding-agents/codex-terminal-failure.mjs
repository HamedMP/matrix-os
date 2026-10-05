import { z } from "zod/v4";

const NativeErrorSchema = z.object({
  message: z.string().max(4096).optional(),
  codexErrorInfo: z.unknown().optional(),
}).passthrough();
const HttpErrorInfoSchema = z.object({
  httpConnectionFailed: z.object({ httpStatusCode: z.number().int().min(100).max(599) }),
}).strict();

/** Classify native terminal errors only. Never persist raw provider error text. */
export function codexTerminalFailureReason(value) {
  const parsed = NativeErrorSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { codexErrorInfo: info, message } = parsed.data;
  if (info === "unauthorized") return "authentication_required";
  if (info === "usageLimitExceeded") return "usage_limit";
  const http = HttpErrorInfoSchema.safeParse(info);
  if (http.success && http.data.httpConnectionFailed.httpStatusCode === 401) return "authentication_required";
  if (http.success && http.data.httpConnectionFailed.httpStatusCode === 402) return "billing_required";
  // Older workspace discovery errors publish only text. Limit recognition to
  // established native error prefixes; tool output and ordinary text never enter here.
  if (info !== undefined && info !== null && info !== "other") return undefined;
  if (typeof message === "string" && (
    /^workspace routing discovery unauthorized \(401\)(?:$|[.:;\s])/.test(message)
    || /^Your access token could not be refreshed because your refresh token was revoked\./.test(message)
    || /^Not logged in(?:[.!]|$)/i.test(message)
  )) return "authentication_required";
  return undefined;
}

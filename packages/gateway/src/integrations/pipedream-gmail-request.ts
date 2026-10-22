import { z } from "zod/v4";
import { boundedOperation } from "../bounded-operation.js";
import { admitGmailSend, type BeforeGmailSend } from "./gmail-send-admission.js";
import { gmailApiTarget, isNativeGmailAccount, NativeGmailRequestError, readGmailResponse,
  type NativeGmailRequest } from "./native-gmail/request.js";

const inputSchema = z.strictObject({
  externalUserId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
  accountId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).refine(id => !isNativeGmailAccount(id)),
  url: z.string().max(8192), params: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(), body: z.record(z.string(), z.unknown()).optional(),
});
const raw = z.string().min(1).max(128 * 1024).regex(/^[A-Za-z0-9_-]+={0,2}$/);
const label = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(id => id !== "TRASH");
const labels = z.array(label).max(100).refine(ids => new Set(ids).size === ids.length).optional();
const modify = z.strictObject({ addLabelIds: labels, removeLabelIds: labels })
  .refine(body => (body.addLabelIds?.length ?? 0) + (body.removeLabelIds?.length ?? 0) > 0)
  .refine(body => !body.addLabelIds?.some(id => body.removeLabelIds?.includes(id)));
function bodyFor(target: URL, method: string, body: unknown): string | undefined {
  if (method === "GET") {
    if (body !== undefined) throw new NativeGmailRequestError();
    return;
  }
  const schema = target.pathname.endsWith("/messages/send") ? z.strictObject({ raw })
    : target.pathname.endsWith("/drafts") ? z.strictObject({ message: z.strictObject({ raw }) })
      : target.pathname.endsWith("/modify") ? modify
        : z.strictObject({ name: z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/).refine(name => name.trim().length > 0) });
  const encoded = JSON.stringify(schema.parse(body));
  if (Buffer.byteLength(encoded) > 128 * 1024) throw new NativeGmailRequestError();
  return encoded;
}

/** Only guarded, reviewed Gmail API paths use this raw transport. No retries, SDK proxy or shared read admission.
 * SDK application-token resolution and Pipedream's remote upstream queue remain independently managed boundaries. */
export function createGuardedPipedreamGmailRequest(options: {
  projectId: string; environment: "development" | "production"; getAccessToken: () => Promise<string>;
  fetcher?: typeof fetch;
}) {
  const projectId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(options.projectId);
  const environment = z.enum(["development", "production"]).parse(options.environment);
  return async (rawInput: NativeGmailRequest, method: string, beforeSend: BeforeGmailSend, parentSignal?: AbortSignal): Promise<unknown> => {
    try {
      if (typeof beforeSend !== "function") throw new NativeGmailRequestError();
      const input = inputSchema.parse(rawInput);
      const target = gmailApiTarget(input, method);
      const body = bodyFor(target, method, input.body);
      const url = new URL(`https://api.pipedream.com/v1/connect/${projectId}/proxy/${Buffer.from(target.href).toString("base64url")}`);
      url.searchParams.set("external_user_id", input.externalUserId); url.searchParams.set("account_id", input.accountId);
      return await boundedOperation(async signal => {
        const token = await options.getAccessToken();
        await admitGmailSend(signal, beforeSend);
        signal.throwIfAborted();
        const response = await (options.fetcher ?? fetch)(url.href, { method, body, redirect: "error", signal,
          headers: { Authorization: `Bearer ${token}`, "x-pd-environment": environment, "x-pd-proxy-accept": "application/json",
            ...(body ? { "Content-Type": "application/json", "x-pd-proxy-content-type": "application/json" } : {}) } });
        return readGmailResponse(response, target, target.pathname.includes("/attachments/") ? 1400 * 1024 : 2 * 1024 * 1024, signal);
      }, 10_000, parentSignal);
    } catch (error: unknown) {
      if (error instanceof NativeGmailRequestError) throw error;
      // Callback, token and network errors may contain private diagnostics; expose no raw message.
      throw new NativeGmailRequestError();
    }
  };
}

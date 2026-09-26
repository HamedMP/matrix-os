import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { JevInboxGmailIdSchema } from "@matrix-os/contracts";
import { gatewayAuthHeaders, type GatewayFetcher } from "../../kernel/dist/tools/integrations.js";

const receipt = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z.strictObject({
  operation: z.enum(["discover", "select", "evaluate"]),
  receipt: receipt.optional(),
  threadId: JevInboxGmailIdSchema.optional(),
}).superRefine((input, context) => {
  if (input.operation === "discover" ? input.receipt !== undefined || input.threadId !== undefined
    : input.operation === "select" ? !input.receipt || !input.threadId
    : !input.receipt || input.threadId !== undefined) {
    context.addIssue({ code: "custom", message: "Invalid Inbox operation" });
  }
});
const MAX_BYTES = 64 * 1024;
const failure = () => ({ isError: true, content: [{ type: "text" as const,
  text: "Inbox preview is unavailable. No mailbox changes have been made." }] });
function cancelBody(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  if (body) void body.cancel().catch((error: unknown) => {
    console.warn("[jev-inbox-tool] Body cleanup failed:", error instanceof Error ? error.name : "UnknownError");
  });
}

/** Sole tool for an isolated recipe process. Account/content/verification authority remains on the server. */
export function registerJevInboxTool(server: McpServer, fetcher: GatewayFetcher = fetch): void {
  server.registerTool("jev_inbox_preview", {
    description: "Read-only Inbox workflow. Discover bounded thread candidates, select a discovered thread with its receipt, then evaluate the resulting evidence receipt. Returns proposals only and never changes email.",
    inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (rawInput) => {
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const signal = AbortSignal.timeout(30_000);
    let aborted: (() => void) | undefined;
    try {
      const input = inputSchema.parse(rawInput);
      const abort = new Promise<never>((_, reject) => {
        aborted = () => reject(new Error("InboxDeadline"));
        signal.addEventListener("abort", aborted, { once: true });
      });
      const requested = fetcher(`${process.env.GATEWAY_URL ?? "http://localhost:4000"}/api/jev/inbox/preview`, {
        method: "POST", headers: gatewayAuthHeaders(), body: JSON.stringify(input), signal, redirect: "error",
      }).then((value) => {
        if (!(value instanceof Response)) throw new Error("InboxResponseUnavailable");
        if (signal.aborted) { cancelBody(value.body); throw new Error("InboxDeadline"); }
        return value;
      });
      const received = await Promise.race([requested, abort]);
      response = received;
      if (!received.ok || !received.body) throw new Error("InboxUnavailable");
      const length = received.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new Error("InboxTooLarge");
      reader = received.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const next = await Promise.race([reader.read(), abort]);
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BYTES || chunks.length >= 4096) throw new Error("InboxTooLarge");
        chunks.push(next.value);
      }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
    } catch (error: unknown) {
      console.warn("[jev-inbox-tool] Unavailable:", error instanceof Error ? error.name : "UnknownError");
      return failure();
    } finally {
      if (aborted) signal.removeEventListener("abort", aborted);
      if (reader) cancelBody(reader);
      else if (response) cancelBody(response.body);
    }
  });
}

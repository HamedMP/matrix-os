import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { JevInboxGmailIdSchema } from "@matrix-os/contracts";
import { gatewayAuthHeaders, type GatewayFetcher } from "../../kernel/dist/tools/integrations.js";
const receipt = z.string().regex(/^[a-f0-9]{64}$/);
const jobId = z.string().regex(/^jev_batch_[a-f0-9]{32}$/);
const inputSchema = z.union([
  z.discriminatedUnion("operation", [
    z.strictObject({ operation: z.literal("discover") }),
    z.strictObject({ operation: z.literal("select"), receipt, threadId: JevInboxGmailIdSchema }),
    z.strictObject({ operation: z.literal("evaluate"), receipt }),
  ]),
  z.discriminatedUnion("operation", [
    z.strictObject({ operation: z.literal("batch_start"), maxThreads: z.number().int().min(1).max(10000).optional() }),
    z.strictObject({ operation: z.literal("batch_next"), jobId, revision: z.number().int().min(1) }),
    z.strictObject({ operation: z.literal("batch_resume"), jobId }),
    z.strictObject({ operation: z.literal("batch_status"), jobId: jobId.optional() }),
  ])
]);
const MAX_BYTES = 64 * 1024;
const failure = () => ({ isError: true, content: [{ type: "text" as const,
      text: "Inbox result is unavailable. If labeling is enabled, changes may be unconfirmed; check Gmail before retrying." }] });
function cancelBody(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  if (body)
    void body.cancel().catch((error: unknown) => {
      console.warn("[jev-inbox-tool] Body cleanup failed:", error instanceof Error ? error.name : "UnknownError");
    });
}
/** Sole tool for an isolated recipe process. Account/content/verification authority remains on the server. */
export function registerJevInboxTool(server: McpServer, fetcher: GatewayFetcher = fetch): void {
  server.registerTool("jev_inbox_preview", {
    description: "For Inbox-wide triage, batch_start then repeat batch_next with the latest returned jobId and revision until terminal/paused, report server progress; batch_status locates saved work and batch_resume continues it. For a targeted thread, discover, select with receipt, then evaluate. The server returns proposals or, when the owner saved labeling permission for this bot, adds verified Jev labels and confirms Gmail readback. Never archives, sends or deletes email.",
    inputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (rawInput) => {
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const signal = AbortSignal.timeout(rawInput.operation === "batch_next" ? 570000 : rawInput.operation === "evaluate" ? 540000 : 60000);
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
        if (!(value instanceof Response))
          throw new Error("InboxResponseUnavailable");
        if (signal.aborted) {
          cancelBody(value.body);
          throw new Error("InboxDeadline");
        }
        return value;
      });
      const received = await Promise.race([requested, abort]);
      response = received;
      if (!received.ok || !received.body)
        throw new Error("InboxUnavailable");
      const length = received.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
        throw new Error("InboxTooLarge");
      reader = received.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const next = await Promise.race([reader.read(), abort]);
        if (next.done)
          break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BYTES || chunks.length >= 4096)
          throw new Error("InboxTooLarge");
        chunks.push(next.value);
      }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
    }
    catch (error: unknown) {
      console.warn("[jev-inbox-tool] Unavailable:", error instanceof Error ? error.name : "UnknownError");
      return failure();
    }
    finally {
      if (aborted)
        signal.removeEventListener("abort", aborted);
      if (reader)
        cancelBody(reader);
      else if (response)
        cancelBody(response.body);
    }
  });
}

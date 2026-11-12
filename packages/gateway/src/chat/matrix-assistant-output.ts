import { BOT_OUTPUT_LIMIT_NOTICE, BOT_OUTPUT_MAX_ENCODED_BYTES, BOT_OUTPUT_MAX_SEGMENTS,
  BOT_OUTPUT_SEGMENT_MAX_ENCODED_BYTES, botOutputEncodedBytes, botOutputPrefix, canonicalAssistantContinuationId } from "@matrix-os/contracts";

/** Reuse canonical, owner-scoped Chat rows and their delta outbox. No full reply
 * is held in memory. Each source/continuation identity is bounded and stable
 * for this dispatch. Credential-emitting coding adapters keep their own policy:
 * sealed credential envelopes must never be rebound to another message ID. */
export function createMatrixAssistantOutput() {
  const sources = new Map<string, { id: string; bytes: number; segment: number }>();
  let usedBytes = 0;
  let segments = 0;
  let stopped = false;
  const noticeBytes = botOutputEncodedBytes(BOT_OUTPUT_LIMIT_NOTICE);
  return {
    append(input: { messageId: string; delta: string; credentials?: readonly unknown[] }) {
      if (stopped || !input.delta) return undefined;
      if (input.credentials?.length) throw new Error("Unexpected Matrix AI credential sidecar");
      let source = sources.get(input.messageId);
      if (!source) {
        if (sources.size >= 64 || segments >= BOT_OUTPUT_MAX_SEGMENTS) throw new Error("Matrix AI output identity limit exceeded");
        source = { id: input.messageId, bytes: 0, segment: 0 };
        sources.set(input.messageId, source);
        segments++;
      }
      const prefix = botOutputPrefix(input.delta, BOT_OUTPUT_MAX_ENCODED_BYTES - noticeBytes - usedBytes);
      stopped = prefix.length !== input.delta.length;
      const delta = prefix + (stopped ? BOT_OUTPUT_LIMIT_NOTICE : "");
      const bytes = botOutputEncodedBytes(delta);
      if (source.bytes + bytes > BOT_OUTPUT_SEGMENT_MAX_ENCODED_BYTES) {
        if (segments >= BOT_OUTPUT_MAX_SEGMENTS) throw new Error("Matrix AI output segment limit exceeded");
        source.segment++;
        source.id = canonicalAssistantContinuationId(input.messageId, source.segment);
        source.bytes = 0;
        segments++;
      }
      source.bytes += bytes;
      usedBytes += bytes;
      return { messageId: source.id, delta };
    },
  };
}

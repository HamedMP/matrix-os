import { expect, it } from "vitest";
import { BOT_OUTPUT_MAX_ENCODED_BYTES, BOT_OUTPUT_LIMIT_NOTICE, BOT_OUTPUT_SEGMENT_MAX_ENCODED_BYTES, botOutputEncodedBytes } from "@matrix-os/contracts";
import { createMatrixAssistantOutput } from "../../packages/gateway/src/chat/matrix-assistant-output.js";

it("retains an exact bounded prefix, one honest limit notice, and no additional text after the limit", () => {
  const output = createMatrixAssistantOutput();
  const sizes = new Map<string, number>();
  let total = 0;
  let notices = 0;
  for (let index = 0; index < 2_200; index++) {
    const result = output.append({ messageId: "msg_synthetic_output", delta: "x".repeat(4_000) });
    if (!result) continue;
    const bytes = botOutputEncodedBytes(result.delta);
    total += bytes;
    sizes.set(result.messageId, (sizes.get(result.messageId) ?? 0) + bytes);
    if (result.delta.endsWith(BOT_OUTPUT_LIMIT_NOTICE)) notices++;
  }
  expect(total).toBe(BOT_OUTPUT_MAX_ENCODED_BYTES);
  expect(notices).toBe(1);
  expect([...sizes.values()].every(size => size <= BOT_OUTPUT_SEGMENT_MAX_ENCODED_BYTES)).toBe(true);
  expect(sizes.size).toBeLessThanOrEqual(192);
  expect(output.append({ messageId: "msg_synthetic_output", delta: "later text" })).toBeUndefined();
});

it("never rebinds credential envelopes into continuation messages", () => {
  const output = createMatrixAssistantOutput();
  expect(() => output.append({ messageId: "msg_synthetic_output", delta: "masked", credentials: [{}] })).toThrow("Unexpected Matrix AI credential sidecar");
});

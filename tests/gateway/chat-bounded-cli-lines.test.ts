import { expect, it } from "vitest";
import { createBoundedCliLines } from "../../packages/gateway/src/chat/bounded-cli-lines.js";

it("consumes bounded frames without a cumulative output cap, preserving fragmented Unicode", () => {
  const frames: unknown[] = [];
  const lines = createBoundedCliLines(32, line => frames.push(JSON.parse(line)));
  const frame = Buffer.from(`${JSON.stringify({ text: "😀" })}\n`);
  for (let index = 0; index < 30; index++) {
    lines.push(frame.subarray(0, 11));
    lines.push(frame.subarray(11));
  }
  lines.finish();
  expect(frames).toEqual(Array.from({ length: 30 }, () => ({ text: "😀" })));
});
it("rejects a single oversized frame and an unfinished frame across chunks", () => {
  const lines = createBoundedCliLines(32, () => undefined);
  lines.push(Buffer.from("x".repeat(20)));
  expect(() => lines.push(Buffer.from("x".repeat(13)))).toThrow("frame exceeded");
  const single = createBoundedCliLines(32, () => undefined);
  expect(() => single.push(Buffer.from(`${"x".repeat(33)}\n`))).toThrow("frame exceeded");
});
it("rejects malformed protocol JSON including a final frame without a newline", () => {
  const lines = createBoundedCliLines(32, JSON.parse);
  lines.push(Buffer.from("{bad}"));
  expect(() => lines.finish()).toThrow(SyntaxError);
});

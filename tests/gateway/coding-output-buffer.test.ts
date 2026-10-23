import { expect, it } from "vitest";
import { createCodingOutputBuffer } from "../../packages/gateway/src/coding-agents/coding-output-buffer.js";

it("keeps consuming complete bounded records after their cumulative bytes exceed the frame allowance", () => {
  const output = createCodingOutputBuffer(16);
  const lines: string[] = [];
  for (const frame of ['{"text":"one"}\n', '{"text":"two"}\n', '{"done":true}\n']) output.push(Buffer.from(frame), line => { lines.push(line); });
  expect(lines).toEqual(['{"text":"one"}', '{"text":"two"}', '{"done":true}']);
});
it("allows several complete frames in one transport chunk without treating the chunk as one frame", () => {
  const output = createCodingOutputBuffer(8);
  const lines: string[] = [];
  output.push(Buffer.from("one\ntwo\nthree\n"), line => { lines.push(line); });
  expect(lines).toEqual(["one", "two", "three"]);
});
it("fails closed on a single oversized frame and on an unfinished oversized frame", () => {
  expect(() => createCodingOutputBuffer(8).push(Buffer.from("123456789\n"), () => undefined)).toThrow(RangeError);
  const fragmented = createCodingOutputBuffer(8);
  fragmented.push(Buffer.from("12345"), () => undefined);
  expect(() => fragmented.push(Buffer.from("6789"), () => undefined)).toThrow(RangeError);
});
it("decodes split multibyte text and returns a final bounded partial record", () => {
  const output = createCodingOutputBuffer(16);
  const lines: string[] = [];
  const bytes = Buffer.from("中\nlast");
  output.push(bytes.subarray(0, 1), line => { lines.push(line); });
  output.push(bytes.subarray(1), line => { lines.push(line); });
  expect(lines).toEqual(["中"]);
  expect(output.finish()).toBe("last");
});

it("bounds individual SSE frames across CRLF transport chunk boundaries", () => {
  const output = createCodingOutputBuffer(8, "\n\n");
  const frames: string[] = [];
  output.push(Buffer.from("one\r"), frame => { frames.push(frame); });
  output.push(Buffer.from("\n\r\ntwo\r\n\r\n"), frame => { frames.push(frame); });
  expect(frames).toEqual(["one", "two"]);
  expect(() => output.push(Buffer.from("123456789\n\n"), () => undefined)).toThrow(RangeError);
});

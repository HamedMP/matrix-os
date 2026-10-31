import { describe, expect, it } from "vitest";
import { createWriterFrame } from "../../../packages/gateway/src/terminal/writer-frame.js";
const creator = { pid: 101, uid: 501, gid: 20 };
const chunk = (data: string, writer = creator) => ({ data: Buffer.from(data), writer });
describe("one bounded kernel-writer Terminal frame", () => {
  it("accepts only one complete frame from the same actual creator/writer", () => {
    const frame = createWriterFrame(creator, 64);
    expect(frame.push(chunk('{"operation":'))).toBeUndefined();
    expect(frame.push(chunk('"list"}\n'))).toEqual({ bytes: '{"operation":"list"}', writer: creator });
    expect(() => frame.push(chunk("\n"))).toThrow();
  });
  it("rejects transferred FD writers even when their JSON claims the original PID", () => {
    const frame = createWriterFrame(creator, 64);
    expect(() => frame.push(chunk('{"pid":101}\n', { ...creator, pid: 102 }))).toThrow();
  });
  it("rejects mixed-writer partial frames and never resumes after rejection", () => {
    const frame = createWriterFrame(creator, 64);
    frame.push(chunk('{"pid":'));
    expect(() => frame.push(chunk('101}\n', { ...creator, pid: 102 }))).toThrow();
    expect(() => frame.push(chunk('101}\n'))).toThrow();
  });
  it.each([undefined, { ...creator, uid: 502 }, { ...creator, gid: 21 }])("rejects missing/changed kernel credentials %j", writer => {
    expect(() => createWriterFrame(creator, 64).push({ data: Buffer.from('{}\n'), writer })).toThrow();
  });
  it.each(['{}\n{}\n', '{}\n ', 'x'.repeat(65), '\n'])('rejects duplicate/trailing/oversize/empty frame', value => {
    expect(() => createWriterFrame(creator, 64).push(chunk(value))).toThrow();
  });
  it("decodes UTF8 only after framing, and rejects invalid encoding", () => {
    const bytes = Buffer.from('{"text":"你好"}\n'), frame = createWriterFrame(creator, 64);
    expect(frame.push({ data: bytes.subarray(0, 11), writer: creator })).toBeUndefined();
    expect(frame.push({ data: bytes.subarray(11), writer: creator })?.bytes).toBe('{"text":"你好"}');
    expect(() => createWriterFrame(creator, 64).push({ data: Buffer.from([255, 10]), writer: creator })).toThrow();
  });
});

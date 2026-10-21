import { expect, it, vi } from "vitest";
import { createTerminalOutputHandoff } from "../../packages/terminal-runtime/src/output-handoff.js";

it("copies and drains buffered output once in order before delivering live output", () => {
  const deliver = vi.fn();
  const handoff = createTerminalOutputHandoff(deliver);
  const first = new Uint8Array([1]);
  handoff.write(first);
  first[0] = 99;
  handoff.write(new Uint8Array([2]));
  expect(deliver).not.toHaveBeenCalled();
  handoff.flush();
  handoff.flush();
  handoff.write(new Uint8Array([3]));
  expect(deliver.mock.calls.map(([data]) => [...data])).toEqual([[1], [2], [3]]);
});

it("bounds the handoff by both retained bytes and chunk count", () => {
  const bytes = createTerminalOutputHandoff(vi.fn());
  bytes.write(new Uint8Array(1024 * 1024));
  expect(() => bytes.write(new Uint8Array([1]))).toThrow();
  const chunks = createTerminalOutputHandoff(vi.fn());
  for (let i = 0; i < 256; i++) chunks.write(new Uint8Array([i]));
  expect(() => chunks.write(new Uint8Array([1]))).toThrow();
});

it("drops retained output on close and rejects further delivery", () => {
  const deliver = vi.fn();
  const handoff = createTerminalOutputHandoff(deliver);
  handoff.write(new Uint8Array([1]));
  handoff.dispose();
  handoff.flush();
  expect(deliver).not.toHaveBeenCalled();
  expect(() => handoff.write(new Uint8Array([2]))).toThrow();
});

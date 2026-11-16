import { afterEach, expect, it, vi } from "vitest";
import { input, ready, setup } from "./claude-native-session-fixture.js";

const secret = "private-prompt-and-bearer-material";
afterEach(() => vi.restoreAllMocks());

it.each(["stdout", "drain"] as const)("logs a safe parse cause for %s without changing failure or physical cleanup", async stage => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const cleanup = vi.fn();
  const { children, turn } = setup();
  const phase = turn({ ...input(), onCleanupConfirmed: cleanup });
  const failed = expect(phase.promise).rejects.toMatchObject({ kind: "invalid_output" });
  await ready();
  const child = children[0]!;
  child.stdout.emit("data", Buffer.from(`{"private":"${secret}"${stage === "stdout" ? "\n" : ""}`));
  if (stage === "drain") child.exit();
  await failed;
  expect(warn).toHaveBeenCalledWith(`[claude-native] Native ${stage === "stdout" ? "output" : "output drain"} unavailable`, "SyntaxError");
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  expect(phase.settled).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(child.kill).toHaveBeenCalledTimes(stage === "stdout" ? 1 : 0);
});

it.each(["typed", "unknown"] as const)("classifies a %s startup callback error without exposing its name or message", async kind => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const cause = kind === "typed" ? Object.assign(new TypeError(secret), { name: secret }) : { name: secret, message: secret };
  const cleanup = vi.fn();
  const { children, turn } = setup();
  const phase = turn({ ...input(), onCleanupConfirmed: cleanup }, { onStart() { throw cause; } });
  await expect(phase.promise).rejects.toMatchObject({ kind: "startup" });
  expect(warn).toHaveBeenCalledWith("[claude-native] Startup observer unavailable", kind === "typed" ? "TypeError" : "UnknownError");
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  expect(phase.settled).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});

it.each(["input", "process"] as const)("retains a safe %s error cause while stopping the original child", async stage => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { children, turn } = setup();
  const phase = turn();
  const failed = expect(phase.promise).rejects.toMatchObject({ kind: "startup" });
  await ready();
  const child = children[0]!;
  (stage === "input" ? child.stdin : child).emit("error", Object.assign(new RangeError(secret), { name: secret }));
  await failed;
  expect(warn).toHaveBeenCalledWith(`[claude-native] Native ${stage} unavailable`, "RangeError");
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(phase.settled).toHaveBeenCalledOnce();
});

it("redacts an untrusted observer error name without interrupting the ordinary turn", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { children, turn } = setup();
  const phase = turn(input(), { onStderr() { throw Object.assign(new Error(secret), { name: secret }); } });
  await ready();
  const child = children[0]!;
  child.stderr.emit("data", Buffer.from(secret));
  expect(child.kill).not.toHaveBeenCalled();
  child.result();
  await expect(phase.promise).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith("[claude-native] Stderr observer unavailable", "Error");
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  expect(phase.settled).toHaveBeenCalledOnce();
});

it("preserves startup failure and physical cleanup when the thrown value rejects prototype inspection", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const cause = new Proxy({}, { getPrototypeOf() { throw new Error(secret); } });
  const cleanup = vi.fn();
  const { children, turn } = setup();
  const phase = turn({ ...input(), onCleanupConfirmed: cleanup }, { onStart() { throw cause; } });
  await expect(phase.promise).rejects.toMatchObject({ kind: "startup" });
  expect(warn).toHaveBeenCalledWith("[claude-native] Startup observer unavailable", "UnknownError");
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  expect(phase.settled).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});

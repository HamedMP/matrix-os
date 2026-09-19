import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { generateAppText } from "../../packages/kernel/src/app-ai.js";
const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);
afterEach(() => vi.resetAllMocks());

it("runs a bounded text-only request without owner tools, project settings, or durable sessions", async () => {
  const close = vi.fn();
  sdk.query.mockImplementation(() => Object.assign((async function* () {
    yield { type: "result", subtype: "success", result: "summary" };
  })(), { close }));
  expect(await generateAppText({ prompt: "hello", model: "configured-model", env: {}, signal: new AbortController().signal })).toEqual({ text: "summary" });
  const options = sdk.query.mock.calls[0][0].options;
  expect(options).toMatchObject({ tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false, maxTurns: 1, maxBudgetUsd: 0.25, model: "configured-model" });
  expect(await options.canUseTool("Bash")).toMatchObject({ behavior: "deny" });
  expect(existsSync(options.cwd)).toBe(false);
  expect(close).toHaveBeenCalledOnce();
});
it("rejects an aborted request before starting the SDK", async () => {
  await expect(generateAppText({ prompt: "hello", model: "configured-model", env: {}, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(sdk.query).not.toHaveBeenCalled();
});
it("cleans up failed generations", async () => {
  const close = vi.fn();
  sdk.query.mockImplementation(() => Object.assign((async function* () {
    yield { type: "result", subtype: "error_max_turns" };
  })(), { close }));
  await expect(generateAppText({ prompt: "hello", model: "configured-model", env: {}, signal: new AbortController().signal })).rejects.toThrow("App AI generation failed");
  expect(existsSync(sdk.query.mock.calls[0][0].options.cwd)).toBe(false);
  expect(close).toHaveBeenCalledOnce();
});
it("does not return provider error text from an SDK success envelope", async () => {
  sdk.query.mockImplementation(() => Object.assign((async function* () {
    yield { type: "result", subtype: "success", is_error: true, result: "private provider failure" };
  })(), { close: vi.fn() }));
  await expect(generateAppText({ prompt: "hello", model: "configured-model", env: {}, signal: new AbortController().signal })).rejects.toThrow("App AI generation failed");
});
it("forwards cancellation to the SDK and removes its scratch directory", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const close = vi.fn();
  sdk.query.mockImplementation(({ options }) => Object.assign((async function* () {
    started();
    await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield { type: "result", subtype: "success", result: "too late" };
  })(), { close }));
  const result = generateAppText({ prompt: "hello", model: "configured-model", env: {}, signal: controller.signal });
  await ready;
  controller.abort();
  await expect(result).rejects.toThrow();
  expect(existsSync(sdk.query.mock.calls[0][0].options.cwd)).toBe(false);
  expect(close).toHaveBeenCalledOnce();
});

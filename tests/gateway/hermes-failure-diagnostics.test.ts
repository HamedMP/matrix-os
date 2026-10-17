import { afterEach, expect, it, vi } from "vitest";
import { createHermesStdioClient } from "../../packages/gateway/src/chat/hermes-stdio-client.js";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import { fakeGateway, baseInput } from "./hermes-test-gateway.js";

afterEach(() => vi.restoreAllMocks());
const secret = "synthetic private token /home/owner/auth.json\nprivate second line";
async function collect(value: AsyncIterable<unknown>) { const rows = []; for await (const row of value) rows.push(row); return rows; }
function diagnostic(calls: unknown[][]) {
  const call = calls.find(row => row[0] === "[chat/hermes] Provider Run failed:")!;
  expect(call).toHaveLength(2);
  expect(typeof call[1]).toBe("string");
  expect(String(call[1])).not.toContain("\n");
  return JSON.parse(String(call[1]));
}

it("retains only the RPC method and numeric code when the native response fails", async () => {
  const gateway = fakeGateway({ ignoreMethods: ["session.create"] });
  const client = createHermesStdioClient({ command: "fixture", args: [], cwd: "/safe", env: {}, spawnFn: gateway.spawnFn, onEvent() {}, onFailure() {} });
  await client.ready();
  const work = client.request("session.create", { private: secret }).catch(error => error);
  const request = gateway.requests[0]!;
  gateway.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: 5032, message: secret, data: { api_key: secret } } }) + "\n");
  const error = await work;
  expect(error).toMatchObject({ name: "HermesGatewayRequestError", method: "session.create", code: 5032 });
  expect(error.message).toBe("Hermes gateway request failed");
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(error.cause).toBeUndefined();
  await client.close();
});

it("does not retain arbitrary method names or out-of-range codes", async () => {
  const gateway = fakeGateway({ ignoreMethods: [secret] });
  const client = createHermesStdioClient({ command: "fixture", args: [], cwd: "/safe", env: {}, spawnFn: gateway.spawnFn, onEvent() {}, onFailure() {} });
  await client.ready();
  const work = client.request(secret, {}).catch(error => error);
  gateway.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: gateway.requests[0]!.id, error: { code: 999999, message: secret } }) + "\n");
  const error = await work;
  expect(error).toMatchObject({ name: "HermesGatewayRequestError", method: "other", code: null });
  expect(JSON.stringify(error)).not.toContain(secret);
  await client.close();
});

it.each([
  ["session.create", "session_create"], ["session.cwd.set", "cwd"], ["config.set", "yolo"],
] as const)("reports the actual %s startup stage without native error content", async (method, stage) => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const gateway = fakeGateway({ ignoreMethods: [method] });
  const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
  const work = collect(adapter.start(baseInput));
  await vi.waitFor(() => expect(gateway.requests.some(request => request.method === method)).toBe(true));
  const request = gateway.requests.find(request => request.method === method)!;
  gateway.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: 5032, message: secret, data: { token: secret } } }) + "\n");
  expect((await work).at(-1)).toMatchObject({ type: "run.completed", outcome: "failed", error: { code: "provider_unavailable" } });
  expect(diagnostic(warning.mock.calls)).toEqual({ stage, kind: "rpc", method, code: 5032, nativeErrorObserved: false });
  expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
  expect(gateway.requests.some(request => request.method === "prompt.submit")).toBe(false);
});

it("distinguishes a native error event from local browser catalog refusal", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const gateway = fakeGateway();
  const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
  const work = collect(adapter.start(baseInput));
  await vi.waitFor(() => expect(gateway.requests.some(request => request.method === "prompt.submit")).toBe(true));
  gateway.event("error", { message: secret });
  await work;
  expect(diagnostic(warning.mock.calls)).toEqual({ stage: "run", kind: "native_event", nativeErrorObserved: true });
  expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
});

it("reports local catalog refusal separately and keeps inference unadmitted", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const gateway = fakeGateway();
  const broker = { openRun: () => ({ token: "a".repeat(43), expiresAt: Date.now() + 60000 }), closeRun: async () => undefined };
  const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn, sharedBrowser: broker as never });
  const work = collect(adapter.start(baseInput));
  await vi.waitFor(() => expect(gateway.requests.some(request => request.method === "config.set")).toBe(true));
  gateway.event("session.info", { lazy: false, tools: { files: ["read_file"] } });
  expect((await work).at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
  expect(diagnostic(warning.mock.calls)).toEqual({ stage: "browser_catalog", kind: "local", errorType: "Error", nativeErrorObserved: false });
  expect(gateway.requests.some(request => request.method === "prompt.submit")).toBe(false);
});

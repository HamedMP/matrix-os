import { afterEach, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import { NativeAppBridge } from "../../desktop/src/main/embeds/native-app-bridge";
import { APP_GENERATE_CHANNEL, createAppGenerateClient } from "@matrix-os/contracts";

const sender = { id: 1, url: "https://gateway.test/apps/brain/" };
function fixture() {
  const generate = vi.fn();
  const bridge = new NativeAppBridge({ authGeneration: () => 0, generate, aiRequest: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(), gatewayOrigin: () => "https://gateway.test" });
  bridge.register(1, "owner/brain", "brain");
  return { bridge, generate };
}
afterEach(() => vi.restoreAllMocks());

it("binds legacy tasks to the registered identity and preserves context", () => {
  const { bridge, generate } = fixture();
  bridge.generate(sender, "Read my notes");
  expect(generate).toHaveBeenCalledWith("owner/brain", "Read my notes");
});
it("rejects forged identities, navigated and retired views, and malformed context", () => {
  const { bridge, generate } = fixture();
  for (const context of [null, {}, "", "  ", "x".repeat(32001)]) {
    expect(() => bridge.generate(sender, context)).toThrow();
  }
  for (const invalid of [{ ...sender, id: 2 }, { ...sender, url: "https://evil.test/apps/brain" }, { ...sender, url: "https://gateway.test/apps/other/" }]) {
    expect(() => bridge.generate(invalid, "hello")).toThrow();
  }
  bridge.unregister(1);
  expect(() => bridge.generate(sender, "hello")).toThrow();
  expect(generate).not.toHaveBeenCalled();
});
it("bounds kernel submissions without affecting the new text API", async () => {
  const { bridge, generate } = fixture();
  const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
  for (let i = 0; i < 10; i++) bridge.generate(sender, "hello");
  expect(() => bridge.generate(sender, "hello")).toThrow("rate limit");
  await expect(bridge.aiGenerate(sender, { prompt: "text" })).resolves.toBeUndefined();
  now.mockReturnValue(160_000);
  bridge.generate(sender, "hello");
  expect(generate).toHaveBeenCalledTimes(11);
});
it("rejects child-frame IPC and normalizes dispatcher failures", () => {
  const { bridge, generate } = fixture();
  const handle = vi.fn();
  bridge.registerIpc({ handle } as Pick<IpcMain, "handle">);
  const handler = handle.mock.calls.find(([channel]) => channel === APP_GENERATE_CHANNEL)![1];
  const frame = {};
  const event = { senderFrame: frame, sender: { id: 1, mainFrame: frame, getURL: () => sender.url } };
  expect(handler(event, "hello")).toEqual({ ok: true });
  expect(() => handler({ ...event, senderFrame: {} }, "hello")).toThrow("App task is unavailable");
  generate.mockImplementation(() => { throw new Error("secret provider error"); });
  expect(() => handler(event, "hello")).toThrow(/^App task is unavailable$/);
});
it("handles asynchronous rejection without changing the legacy void return", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const generate = createAppGenerateClient(async () => { throw new Error("private"); });
  expect(generate("hello")).toBeUndefined();
  await Promise.resolve();
  expect(warning).toHaveBeenCalledWith("[app-generate] App task is unavailable", "Error");
});

it("revokes every app capability when the authenticated account generation changes", async () => {
  let generation = 1;
  const generate = vi.fn();
  const aiRequest = vi.fn();
  const request = vi.fn();
  const bridge = new NativeAppBridge({ generate, aiRequest, request, gatewayRequest: vi.fn(), gatewayOrigin: () => "https://gateway.test", authGeneration: () => generation });
  bridge.register(1, "brain");
  bridge.generate(sender, "original account");
  generation = 2;
  expect(() => bridge.generate(sender, "another account")).toThrow();
  await expect(bridge.aiGenerate(sender, { prompt: "another account" })).rejects.toThrow();
  await expect(bridge.query(sender, { action: "count", table: "notes" })).rejects.toThrow();
  expect(generate).toHaveBeenCalledTimes(1);
  expect(aiRequest).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  bridge.register(1, "brain");
  bridge.generate(sender, "newly registered account");
  expect(generate).toHaveBeenCalledTimes(2);
});

import { expect, it, vi } from "vitest";
import { BotToolRequestSchema } from "@matrix-os/contracts";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
const binding = { kind: "managed_chat", ownerId: "owner_qa", chatId: "chat_qa", runId: "run_browser_qa", runtimeHandle: `runtime_${"a".repeat(32)}`,
  executionGeneration: "1", capabilities: ["browser.action"], workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64) } as ManagedPiRuntimeBinding;
function setup() {
  const controller = new AbortController();
  const authority = vi.fn(async () => ({ permissionMode: "full_access" }));
  const browser = { openRun: vi.fn(() => ({ token: "a".repeat(64), expiresAt: Date.now() + 60000 })),
    execute: vi.fn(async () => ({ status: "agent" })), closeRun: vi.fn(async () => undefined) };
  const tools = createManagedPiOwnerTools({ authority, signalFor: () => controller.signal, sharedBrowser: browser as never });
  return { tools, browser, controller, authority };
}
const request = (id: string) => BotToolRequestSchema.parse({ toolCallId: id, capability: "browser.action", args: { action: "status" } });
it("preserves a replacement run when an older delayed admission fails", async () => {
  const { tools, authority, browser } = setup();
  let release!: () => void;
  authority.mockImplementationOnce(() => new Promise(resolve => {
    release = () => resolve({ permissionMode: "full_access" });
  }));
  const oldAdmission = tools.open(binding, () => undefined);
  const oldFailure = expect(oldAdmission).rejects.toThrow();
  await tools.closeRun(binding.runId);
  await tools.open(binding, () => undefined);
  release();
  await oldFailure;
  await expect(tools.dispatch(binding, request("replacement_browser"), new AbortController().signal)).resolves.toMatchObject({ ok: true });
  expect(browser.execute).toHaveBeenCalledOnce();
});
it("registers exact Pi owner/chat/run and routes tools to the same broker, cleaning only the run", async () => {
  const { tools, browser } = setup();
  expect(tools.capabilities).toContain("browser.action");
  await tools.open(binding, () => undefined);
  expect(browser.openRun).toHaveBeenCalledWith({ ownerId: binding.ownerId, chatId: binding.chatId, runId: binding.runId, harness: "pi" }, expect.any(AbortSignal));
  await tools.dispatch(binding, request("browser_1"), new AbortController().signal);
  expect(browser.execute).toHaveBeenCalledWith({ ownerId: binding.ownerId, chatId: binding.chatId, runId: binding.runId, harness: "pi" }, { action: "status" }, expect.any(AbortSignal));
  await tools.closeRun(binding.runId);
  expect(browser.closeRun).toHaveBeenCalledOnce();
  await expect(tools.dispatch(binding, request("browser_late"), new AbortController().signal)).rejects.toThrow();
});
it("fails closed when full access is revoked or binding is stale, including action-time checks", async () => {
  const { tools, browser, authority, controller } = setup();
  await tools.open(binding, () => undefined);
  authority.mockResolvedValue({ permissionMode: "supervised" });
  await expect(tools.dispatch(binding, request("browser_denied"), new AbortController().signal)).rejects.toThrow();
  authority.mockResolvedValue({ permissionMode: "full_access" });
  await expect(tools.dispatch({ ...binding, chatId: "other" }, request("browser_other"), new AbortController().signal)).rejects.toThrow();
  controller.abort();
  await expect(tools.dispatch(binding, request("browser_aborted"), new AbortController().signal)).rejects.toThrow();
  expect(browser.execute).not.toHaveBeenCalled();
});
it("advertises nothing when browser is unavailable and does not register unauthorized runs", async () => {
  expect(createManagedPiOwnerTools({ authority: async () => ({ permissionMode: "full_access" }), signalFor: () => null }).capabilities).not.toContain("browser.action");
  const { tools, authority, browser } = setup();
  authority.mockResolvedValue({ permissionMode: "supervised" });
  await expect(tools.open(binding, () => undefined)).rejects.toThrow();
  expect(browser.openRun).not.toHaveBeenCalled();
});
it("keeps a known no-effect pause refusal observable so Pi can take a fresh snapshot", async () => {
  const { tools, browser } = setup();
  const { SharedBrowserError } = await import("../../../packages/gateway/src/shared-browser/broker.js");
  await tools.open(binding, () => undefined);
  browser.execute.mockRejectedValueOnce(new SharedBrowserError("observe_again"));
  Object.assign(browser, { status: () => ({ phase: "agent", revision: 3, run: { chatId: binding.chatId, runId: binding.runId, harness: "pi" }, needsObservation: true }) });
  const result = await tools.dispatch(binding, request("browser_paused"), new AbortController().signal);
  expect(result.ok).toBe(true);
  if (result.ok) expect(JSON.parse(result.content[0]!.text)).toMatchObject({ success: false });
  expect(JSON.stringify(result)).toMatch(/fresh snapshot/i);
  browser.execute.mockRejectedValueOnce(new SharedBrowserError("browser_changed", true));
  await expect(tools.dispatch(binding, request("browser_unknown"), new AbortController().signal)).rejects.toThrow();
});

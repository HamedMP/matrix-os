import { afterEach, expect, it, vi } from "vitest";
import { BotToolRequestSchema } from "@matrix-os/contracts";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import { createSharedBrowserBroker, SharedBrowserError } from "../../../packages/gateway/src/shared-browser/broker.js";
import type { SharedBrowserApprovalRequest } from "../../../packages/gateway/src/shared-browser/approval-policy.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";

const binding = { kind: "managed_chat", ownerId: "owner_pi", chatId: "chat_pi", runId: "run_pi", runtimeHandle: `runtime_${"a".repeat(32)}`,
 executionGeneration: "1", capabilities: ["browser.action"], workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64) } as ManagedPiRuntimeBinding;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function setup(enabled = true) {
 let allow!: () => void;
 const waiting = new Promise<void>(yes => { allow = yes; });
 const authorizeAction = vi.fn(async (_request: SharedBrowserApprovalRequest) => waiting);
 const controller = new AbortController();
 const authority = vi.fn(async () => ({ permissionMode: "supervised" }));
 const driver = { execute: vi.fn(async () => ({ success: true, title: "Example Domain", observationId: "fresh" })), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}) };
 const broker = createSharedBrowserBroker({ ownerId: binding.ownerId, driver, setHumanControl: async () => {}, ...(enabled ? { authorizeAction } : {}) });
 const tools = createManagedPiOwnerTools({ authority, signalFor: () => controller.signal, sharedBrowser: broker });
 cleanup.push(() => broker.close()); cleanup.push(() => tools.closeRun(binding.runId));
 return { tools, broker, driver, authorizeAction, controller, allow, authority };
}
const request = (id: string) => BotToolRequestSchema.parse({ toolCallId: id, capability: "browser.action", args: { action: "snapshot" } });
it("holds a supervised Pi browser call at the real broker until owner authority releases it", async () => {
 const s = setup(); await s.tools.open(binding, () => {});
 const work = s.tools.dispatch(binding, request("call_allow"), s.controller.signal);
 await vi.waitFor(() => expect(s.authorizeAction).toHaveBeenCalledOnce());
 expect(s.driver.execute).not.toHaveBeenCalled();
 expect(s.authorizeAction.mock.calls[0]![0]).toMatchObject({ binding: { ownerId: binding.ownerId, chatId: binding.chatId, runId: binding.runId, harness: "pi" }, action: { action: "snapshot" } });
 s.allow(); expect((await work).ok).toBe(true); expect(s.driver.execute).toHaveBeenCalledOnce();
});
it("does not call Chrome or retry after an owner denial", async () => {
 const s = setup(); s.authorizeAction.mockRejectedValue(new SharedBrowserError("browser_changed"));
 await s.tools.open(binding, () => {}); const result = await s.tools.dispatch(binding, request("call_deny"), s.controller.signal);
 expect(result.ok && JSON.parse(result.content[0]!.text)).toMatchObject({ success: false });
 expect(s.authorizeAction).toHaveBeenCalledOnce(); expect(s.driver.execute).not.toHaveBeenCalled();
});
it("releases a pending permission wait on cancellation without dispatching", async () => {
 const s = setup(); await s.tools.open(binding, () => {});
 const work = s.tools.dispatch(binding, request("call_cancel"), s.controller.signal); const result = work.catch(error => error);
 await vi.waitFor(() => expect(s.authorizeAction).toHaveBeenCalledOnce()); s.controller.abort(); await result;
 expect(s.driver.execute).not.toHaveBeenCalled();
});
it("fails closed without the signed authority callback", async () => {
 const s = setup(false); await expect(s.tools.open(binding, () => {})).rejects.toThrow(); expect(s.driver.execute).not.toHaveBeenCalled();
});
it("refuses a permission-mode change instead of reusing a lease with different policy", async () => {
 const s = setup(); await s.tools.open(binding, () => {}); s.authority.mockResolvedValue({ permissionMode: "full_access" });
 await expect(s.tools.dispatch(binding, request("call_changed"), s.controller.signal)).rejects.toThrow();
 expect(s.authorizeAction).not.toHaveBeenCalled(); expect(s.driver.execute).not.toHaveBeenCalled();
});
it("keeps Pi's logical call waiting through pause and human takeover, then observes instead of replaying navigation", async () => {
 const s = setup(); await s.tools.open(binding, () => {});
 const navigate = BotToolRequestSchema.parse({ toolCallId: "call_takeover", capability: "browser.action", args: { action: "navigate", url: "https://example.com" } });
 const work = s.tools.dispatch(binding, navigate, s.controller.signal);
 await vi.waitFor(() => expect(s.authorizeAction).toHaveBeenCalledOnce());
 await s.broker.control(binding.ownerId, { action: "pause" });
 expect(s.broker.status().phase).toBe("paused");
 await s.broker.control(binding.ownerId, { action: "takeover" });
 expect(s.broker.status().phase).toBe("human"); expect(s.driver.execute).not.toHaveBeenCalled();
 s.authorizeAction.mockResolvedValue(undefined);
 await s.broker.control(binding.ownerId, { action: "resume" });
 expect((await work).ok).toBe(true);
 expect(s.driver.execute).toHaveBeenCalledExactlyOnceWith({ action: "snapshot" }, expect.any(AbortSignal));
});

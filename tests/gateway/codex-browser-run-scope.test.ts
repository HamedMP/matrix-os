import { expect, it, vi } from "vitest";
import { createCodexBrowserRunScope } from "../../packages/gateway/src/chat/codex-browser-run-scope.js";
import { nativeBrowserExecution } from "../../packages/gateway/src/chat/native-browser-execution-context.js";
it("binds admission, revokes cancel before state exists, and drains the exact attempt", async () => {
 const close=vi.fn(async()=>{});let live=true;
 const broker={openRun:vi.fn((_binding,signal)=>{signal.addEventListener("abort",()=>{live=false});return{token:"a".repeat(43),expiresAt:1,close};}),resolveCapability:()=>live?{}:null} as never;
 const scope=createCodexBrowserRunScope({broker,gatewayPort:4000});
 const input={owner:{type:"personal",ownerId:"owner"},chatId:"chat",runId:"run",permissionMode:"full_access",interactionMode:"default",signal:new AbortController().signal};
 const attempt=scope.open(input);expect(attempt.withContext(()=>nativeBrowserExecution("owner")?.token)).toBe("a".repeat(43));
 await scope.cancel({ownerId:"foreign",chatId:"chat",runId:"run"});expect(live).toBe(true);
 await scope.cancel({ownerId:"owner",chatId:"chat",runId:"run"});expect(live).toBe(false);expect(close).toHaveBeenCalledTimes(1);
 expect(()=>scope.open(input)).toThrow("Browser run unavailable");
 await attempt.close();expect(close).toHaveBeenCalledTimes(1);
});
it("caps concurrent attempts and does not inherit authority for excluded scopes",async()=>{
 const scope=createCodexBrowserRunScope(undefined,1);const input={owner:{type:"personal",ownerId:"owner"},chatId:"chat",runId:"run",permissionMode:"supervised",interactionMode:"default",signal:new AbortController().signal};
 const a=scope.open(input);expect(a.withContext(()=>nativeBrowserExecution("owner"))).toBeUndefined();expect(()=>scope.open({...input,runId:"other"})).toThrow();await a.close();await scope.open(input).close();
});

it("bounds tracked bootstraps and rechecks a late cleanup failure after an already settled drain", async () => {
  const { beginNativeBrowserBootstrap, markNativeBrowserCleanupUnconfirmed } = await import("../../packages/gateway/src/chat/native-browser-execution-context.js");
  const broker = { openRun: () => ({ token: "a".repeat(43), expiresAt: 1, close: async () => {} }), resolveCapability: () => ({}) } as never;
  const scope = createCodexBrowserRunScope({ broker, gatewayPort: 4000 });
  const callback = vi.fn();
  const input = { owner: { type: "personal", ownerId: "owner" }, chatId: "chat", runId: "run_late",
    permissionMode: "full_access", interactionMode: "default", signal: new AbortController().signal, onCleanupUnconfirmed: callback };
  const attempt = scope.open(input);
  await scope.cancel({ ownerId: "owner", chatId: "chat", runId: input.runId });
  attempt.withContext(() => markNativeBrowserCleanupUnconfirmed("owner"));
  await expect(attempt.close()).rejects.toThrow("Browser cleanup unconfirmed");
  await expect(attempt.close()).rejects.toThrow("Browser cleanup unconfirmed");
  expect(callback).toHaveBeenCalledOnce();
  expect(() => scope.open(input)).toThrow("Browser run unavailable");
  const capped = scope.open({ ...input, runId: "run_capped" });
  const tracked = capped.withContext(() => Array.from({ length: 4 }, () => beginNativeBrowserBootstrap("owner")!));
  expect(() => capped.withContext(() => beginNativeBrowserBootstrap("owner"))).toThrow("Browser cleanup unconfirmed");
  tracked.forEach(entry => entry.finish());
  await expect(capped.close()).rejects.toThrow("Browser cleanup unconfirmed");
});

import { expect, it, vi } from "vitest";
import { prepareCodexBrowser } from "../../packages/gateway/src/coding-agents/codex-browser-bootstrap-client.js";
import { withNativeBrowserExecution } from "../../packages/gateway/src/chat/native-browser-execution-context.js";
it.each([true,false])("confirms physical cleanup after an uncertain bootstrap acknowledgement (stopped=%s)",async(stopped)=>{
 const failure=new Error('Unknown acknowledgement');const prepareBrowser=vi.fn(async()=>{throw failure});const stopSession=vi.fn(async()=>({ok:stopped}));const unconfirmed=vi.fn();
 const browser={isLive:()=>true,token:'a'.repeat(43),attemptId:'123e4567-e89b-42d3-a456-426614174000',mcpServer:{env:{MATRIX_SHARED_BROWSER_GATEWAY_PORT:'4000'}}} as never;
 await expect(withNativeBrowserExecution('owner',browser,()=>prepareCodexBrowser({ownerId:'owner',sessionId:'sess_bootstrap',browser,control:{prepareBrowser} as never,runtime:{stopSession} as never,signal:new AbortController().signal}),unconfirmed)).rejects.toBe(failure);
 expect(prepareBrowser).toHaveBeenCalledTimes(1);expect(stopSession).toHaveBeenCalledOnce();expect(unconfirmed).toHaveBeenCalledTimes(stopped?0:1);
});

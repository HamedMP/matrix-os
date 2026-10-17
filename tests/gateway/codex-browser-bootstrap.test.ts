import { SHARED_BROWSER_ACTION_DEADLINE_MS } from "@matrix-os/contracts";
import { expect,it } from "vitest";
import { createCodexBrowserBootstrap,codexBrowserThreadConfig,codexBrowserChildEnvironment } from "../../packages/gateway/src/coding-agents/codex-browser-bootstrap.mjs";
const lease={attemptId:"123e4567-e89b-42d3-a456-426614174000",token:"a".repeat(43),gatewayPort:4000};
it("does not admit inference until the exact private lease is ready and explicitly released",async()=>{
 const gate=createCodexBrowserBootstrap(lease.attemptId);let bound=false;const binding=gate.bind(lease).then(value=>{bound=value;});
 expect(await gate.waitLease(new AbortController().signal)).toEqual(lease);await Promise.resolve();expect(bound).toBe(false);
 gate.markReady();await binding;expect(bound).toBe(true);let released=false;const release=gate.waitRelease(new AbortController().signal).then(()=>{released=true;});await Promise.resolve();expect(released).toBe(false);
 expect(gate.release("wrong")).toBe(false);expect(gate.release(lease.attemptId)).toBe(true);await release;expect(released).toBe(true);
});
it("fails wrong generations, cancellation and native readiness failures closed",async()=>{
 const gate=createCodexBrowserBootstrap(lease.attemptId);expect(await gate.bind({...lease,attemptId:"223e4567-e89b-42d3-a456-426614174000"})).toBe(false);
 const pending=gate.bind(lease);gate.fail();expect(await pending).toBe(false);expect(gate.release(lease.attemptId)).toBe(false);
 await expect(gate.waitLease(new AbortController().signal)).rejects.toThrow();
 const cancelled=createCodexBrowserBootstrap(lease.attemptId);const controller=new AbortController();const waiting=expect(cancelled.waitLease(controller.signal)).rejects.toThrow();controller.abort();await waiting;
});
it("puts only environment-variable names in native MCP config and clears inherited authority",()=>{
 const config=codexBrowserThreadConfig(lease);
 expect(config['mcp_servers.matrix_shared_browser'].tool_timeout_sec * 1000).toBeGreaterThan(SHARED_BROWSER_ACTION_DEADLINE_MS);
 expect(JSON.stringify(config)).not.toContain(lease.token);
 expect(config['mcp_servers.matrix_shared_browser'].tools).toEqual({shared_browser:{approval_mode:'approve'}});
 expect(config['mcp_servers.matrix_shared_browser']).toMatchObject({env_vars:['MATRIX_SHARED_BROWSER_TOKEN','MATRIX_SHARED_BROWSER_GATEWAY_PORT'],required:true,enabled_tools:['shared_browser'],tool_timeout_sec:390});
 expect(codexBrowserChildEnvironment({BASE:'value',MATRIX_SHARED_BROWSER_TOKEN:'stale'},lease)).toEqual({BASE:'value',MATRIX_SHARED_BROWSER_TOKEN:lease.token,MATRIX_SHARED_BROWSER_GATEWAY_PORT:'4000'});
 expect(codexBrowserChildEnvironment({BASE:'value',MATRIX_SHARED_BROWSER_TOKEN:'stale',MATRIX_SHARED_BROWSER_GATEWAY_PORT:'4000'},undefined)).toEqual({BASE:'value'});
 expect(codexBrowserThreadConfig(undefined)).toEqual({'mcp_servers.matrix_shared_browser':{
  command:'/opt/matrix/runtime/node/bin/node',
  args:['/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js'],
  enabled:false,
 }});
});

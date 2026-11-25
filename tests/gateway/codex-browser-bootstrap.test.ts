import { SHARED_BROWSER_ACTION_DEADLINE_MS } from "@matrix-os/contracts";
import { expect,it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createCodexBrowserBootstrap,codexBrowserThreadConfig,codexBrowserChildEnvironment,createCodexBrowserTokenFile,canRenewCodexBrowserInPlace,sweepCodexBrowserTokenDirs } from "../../packages/gateway/src/coding-agents/codex-browser-bootstrap.mjs";
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
it("renews the run bearer through a private token file named only by path",async()=>{
 expect(await createCodexBrowserTokenFile(false)).toBeUndefined();
 const file=(await createCodexBrowserTokenFile(true))!;
 try{
  const config=codexBrowserThreadConfig(lease,{tokenFile:true});
  expect(config['mcp_servers.matrix_shared_browser']).toMatchObject({env_vars:['MATRIX_SHARED_BROWSER_TOKEN_FILE','MATRIX_SHARED_BROWSER_GATEWAY_PORT'],required:true});
  const env=codexBrowserChildEnvironment({BASE:'value',MATRIX_SHARED_BROWSER_TOKEN:'stale',MATRIX_SHARED_BROWSER_TOKEN_FILE:'/stale'},lease,file.path);
  expect(env).toEqual({BASE:'value',MATRIX_SHARED_BROWSER_TOKEN_FILE:file.path,MATRIX_SHARED_BROWSER_GATEWAY_PORT:'4000'});
  expect(JSON.stringify(env)).not.toContain(lease.token);
  expect(codexBrowserChildEnvironment({MATRIX_SHARED_BROWSER_TOKEN_FILE:'/stale'},undefined,file.path)).toEqual({});
  await file.write(lease.token);expect(await readFile(file.path,'utf8')).toBe(lease.token);
  expect((await lstat(file.path)).mode&0o077).toBe(0);expect((await lstat(file.path.replace(/\/token$/,''))).mode&0o077).toBe(0);
  await file.write('b'.repeat(43));expect(await readFile(file.path,'utf8')).toBe('b'.repeat(43));
  await expect(file.write('not-a-token')).rejects.toThrow();
  await file.clear();await expect(readFile(file.path,'utf8')).rejects.toThrow();
  const next={...lease,attemptId:'223e4567-e89b-42d3-a456-426614174000',token:'b'.repeat(43)};
  expect(canRenewCodexBrowserInPlace(lease,next,file)).toBe(true);
  expect(canRenewCodexBrowserInPlace(lease,{...next,gatewayPort:4001},file)).toBe(false);
  expect(canRenewCodexBrowserInPlace(undefined,next,file)).toBe(false);
  expect(canRenewCodexBrowserInPlace(lease,undefined,file)).toBe(false);
  expect(canRenewCodexBrowserInPlace(lease,next,undefined)).toBe(false);
 }finally{await file.close();}
 await expect(lstat(file.path)).rejects.toThrow();
});
it("names the bearer directory by runner pid and sweeps only dead runners' leftovers",async()=>{
 const file=(await createCodexBrowserTokenFile(true))!;
 try{expect(basename(file.path.replace(/\/token$/,''))).toMatch(new RegExp(`^matrix-codex-browser-${process.pid}-[A-Za-z0-9]{6}$`));}finally{await file.close();}
 const root=await mkdtemp(join(tmpdir(),'browser-sweep-'));
 try{
  const old=new Date(Date.now()-10*60_000);
  const make=async(name:string,age=old)=>{const path=join(root,name);await mkdir(path);await writeFile(join(path,'token'),'a'.repeat(43),{mode:0o600});await utimes(path,age,age);return path;};
  const dead=await make('matrix-codex-browser-999991-AbCdEf');
  const live=await make(`matrix-codex-browser-${process.pid}-AbCdEf`);
  const fresh=await make('matrix-codex-browser-999992-AbCdEf',new Date());
  const target=await make('unrelated-dir');
  await symlink(target,join(root,'matrix-codex-browser-999993-AbCdEf'));
  await writeFile(join(root,'matrix-codex-browser-999994-AbCdEf'),'not a dir');
  const removed=await sweepCodexBrowserTokenDirs({root,isAlive:(pid:number)=>pid===process.pid});
  expect(removed).toBe(1);
  await expect(lstat(dead)).rejects.toThrow();
  for(const kept of [live,fresh,target,join(root,'matrix-codex-browser-999993-AbCdEf'),join(root,'matrix-codex-browser-999994-AbCdEf')])expect(await lstat(kept)).toBeTruthy();
  expect(await readFile(join(target,'token'),'utf8')).toBe('a'.repeat(43));
 }finally{await rm(root,{recursive:true,force:true});}
});

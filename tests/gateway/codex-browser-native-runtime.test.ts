import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createCodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
async function waitFor(check:()=>Promise<boolean>){const end=Date.now()+6000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error("Fixture wait expired");}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const closed=new Promise<void>(r=>child.once("close",()=>r()));child.kill("SIGTERM");await closed;}
it.each(["browser", "restricted", "catalog_failed"])("keeps native authority fail-closed through %s lifecycle",async(mode)=>{
 const home=await mkdtemp('/tmp/mx-browser-native-');const calls:string[]=[];
 const gateway=createServer((req,res)=>{calls.push(req.headers.authorization??'');res.writeHead(200,{'content-type':'application/json'});res.end('{"success":true}');});
 await new Promise<void>(r=>gateway.listen(0,'127.0.0.1',r));const address=gateway.address();if(!address||typeof address==='string')throw new Error('Fixture port unavailable');
 const fake=join(home,'native.mjs'),trace=join(home,'synthetic-trace.jsonl');
 const require=createRequire(import.meta.url);const clientModule=pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href;const transportModule=pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href;
 const mcpCli=join(process.cwd(),'packages/integrations-mcp/src/shared-browser-cli.ts');
 await writeFile(fake,String.raw`import {createInterface} from 'node:readline';
import {appendFile} from 'node:fs/promises';
const log=async value=>appendFile(process.env.SYNTHETIC_TRACE,JSON.stringify(value)+'\n');
await log({event:'spawn',pid:process.pid});
process.on('SIGTERM',async()=>{await log({event:'closed',pid:process.pid});process.exit(0);});
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==='initialize')reply(m.id,{userAgent:'synthetic',platformFamily:'unix',platformOs:'linux',codexHome:'synthetic'});
 else if(m.method==='thread/start'||m.method==='thread/resume'){
  await log({event:m.method,pid:process.pid,params:m.params});reply(m.id,{thread:{id:'native-browser-thread'}});
 }else if(m.method==='mcpServerStatus/list'){
  const {Client}=await import(process.env.SYNTHETIC_MCP_CLIENT);const {StdioClientTransport}=await import(process.env.SYNTHETIC_MCP_TRANSPORT);
  const client=new Client({name:'synthetic-native',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',process.env.SYNTHETIC_TSX,process.env.SYNTHETIC_MCP_CLI],env:process.env,stderr:'pipe'}));
  const tools=await client.listTools();if(tools.tools.length!==1||tools.tools[0].name!=='shared_browser')throw new Error('Synthetic catalog mismatch');
  const result=await client.callTool({name:'shared_browser',arguments:{action:'status'}});if(result.isError)throw new Error('Synthetic action unavailable');await client.close();
  reply(m.id,{data:[{name:'matrix_shared_browser',runtimeStatus:process.env.SYNTHETIC_CATALOG_FAILED?'failed':'connected',tools:{shared_browser:{}}}]});
 }else if(m.method==='turn/start'){
  await log({event:'turn',pid:process.pid});reply(m.id,{turn:{id:'native-turn-'+process.pid}});
  process.stdout.write(JSON.stringify({method:'turn/completed',params:{turn:{id:'native-turn-'+process.pid,status:'completed',items:[]}}})+'\n');
 }
}
`);
 const event=codexProviderEventPath(home,'sess_browser_native');const nonce=randomUUID();
 const config=Buffer.from(JSON.stringify({prompt:'Synthetic',approvalPolicy:'never',sandbox:'danger-full-access',writableRoots:[],...(mode!=="restricted"?{browserAttemptId:nonce}:{})})).toString('base64');
 const child=spawn(process.execPath,[join(process.cwd(),'packages/gateway/src/coding-agents/codex-app-server-runner.mjs'),event,process.version.slice(1),process.execPath,fake,config],{cwd:home,env:{...process.env,SYNTHETIC_TRACE:trace,SYNTHETIC_MCP_CLIENT:clientModule,SYNTHETIC_MCP_TRANSPORT:transportModule,SYNTHETIC_MCP_CLI:mcpCli,SYNTHETIC_TSX:pathToFileURL(require.resolve("tsx")).href,...(mode==='catalog_failed'?{SYNTHETIC_CATALOG_FAILED:'1'}:{}),MATRIX_BACKGROUND_AGENT:'1'},stdio:['ignore','pipe','pipe']});
 let diagnostics='';child.stderr?.on('data',chunk=>{diagnostics+=chunk});child.stdout?.resume();
 const readTrace=async()=>{try{return(await readFile(trace,'utf8')).trim().split('\n').map(x=>JSON.parse(x));}catch{return[];}};
 try{
  const control=createCodexControlClient({homePath:home});
  if(mode==='restricted'){
   await waitFor(async()=> (await readTrace()).some(x=>x.event==='turn'));
   const rows=await readTrace();expect(rows[1].params.config['mcp_servers.matrix_shared_browser']).toEqual({enabled:false});expect(calls).toEqual([]);return;
  }
  await new Promise(r=>setTimeout(r,100));expect(await readTrace()).toEqual([]);
  if(mode==='catalog_failed'){
   await expect(control.prepareBrowser!({sessionId:'sess_browser_native',browser:{attemptId:nonce,token:'a'.repeat(43),gatewayPort:address.port},signal:AbortSignal.timeout(5000)})).rejects.toThrow();
   expect((await readTrace()).some(x=>x.event==='turn')).toBe(false);return;
  }
  await control.prepareBrowser!({sessionId:'sess_browser_native',browser:{attemptId:nonce,token:'a'.repeat(43),gatewayPort:address.port},signal:AbortSignal.timeout(5000)});
  await waitFor(async()=> (await readTrace()).some(x=>x.event==='turn'));
  expect(calls).toEqual(['Bearer '+'a'.repeat(43)]);
  await control.submitTurn({sessionId:'sess_browser_native',turnId:'turn_browser_second',prompt:'Next synthetic',modelOptions:[],browser:{attemptId:randomUUID(),token:'b'.repeat(43),gatewayPort:address.port}});
  await waitFor(async()=> (await readTrace()).filter(x=>x.event==='turn').length===2);
  const rows=await readTrace();expect(rows.map(x=>x.event)).toEqual(['spawn','thread/start','turn','closed','spawn','thread/resume','turn']);
  expect(rows[3].pid).toBe(rows[0].pid);expect(rows[4].pid).not.toBe(rows[0].pid);
  expect(rows[5].params.threadId).toBe('native-browser-thread');expect(calls).toEqual(['Bearer '+'a'.repeat(43),'Bearer '+'b'.repeat(43)]);
  await control.submitTurn({sessionId:'sess_browser_native',turnId:'turn_browser_restricted',prompt:'Restricted synthetic',modelOptions:[]});
  await waitFor(async()=> (await readTrace()).filter(x=>x.event==='turn').length===3);
  const restrictedRows=await readTrace();expect(restrictedRows.at(-2).params.config['mcp_servers.matrix_shared_browser']).toEqual({enabled:false});expect(calls).toHaveLength(2);
  const persisted=JSON.stringify(restrictedRows)+await readFile(event,'utf8')+Buffer.from(config,'base64').toString();expect(persisted).not.toContain('a'.repeat(43));expect(persisted).not.toContain('b'.repeat(43));
  expect(rows[1].params.config['mcp_servers.matrix_shared_browser'].env_vars).toEqual(['MATRIX_SHARED_BROWSER_TOKEN','MATRIX_SHARED_BROWSER_GATEWAY_PORT']);
 }catch(error){throw new Error('Synthetic native browser regression failed: '+String(error)+' '+diagnostics);}
 finally{await stop(child);await new Promise<void>(r=>gateway.close(()=>r()));await rm(home,{recursive:true,force:true});}
},15000);

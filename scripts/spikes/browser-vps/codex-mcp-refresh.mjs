/** No inference/auth calls or persistent config writes. Run in a credential-free sandbox. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir, lstat, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { SYNTHETIC_MCP_SOURCE, createProbeClient } from "./codex-mcp-probe-support.mjs";
const executable = process.argv[2];
if (!executable || process.argv[3] !== "--isolated-home") throw new Error("Pass the pinned executable and --isolated-home only inside a disposable-home sandbox");
const envVarsMode = process.argv[4] === "--env-vars";
const markerA = `matrix_probe_marker_${randomUUID()}`;
const markerB = `matrix_probe_marker_${randomUUID()}`;
const scratch = await mkdtemp(join(tmpdir(), "matrix-codex-mcp-probe-"));
const mock = join(scratch, "mock.mjs");
await writeFile(mock, SYNTHETIC_MCP_SOURCE, { mode: 0o600 });
// HOME and credentials must be isolated by the caller. These flags do not read auth.
const child = spawn(executable, ["-c", 'mcp_servers={}', "app-server"], { cwd: scratch, env: { PATH: process.env.PATH, ...(envVarsMode ? { MATRIX_SYNTHETIC_MARKER: markerA } : {}) }, stdio: ["pipe", "pipe", "ignore"] });
const closed=new Promise(resolve=>child.once("close",resolve));
const client=createProbeClient(child);const request=client.request;
const config=marker=>({'mcp_servers.matrix_synthetic':{command:process.execPath,args:[mock],...(envVarsMode ? {env_vars:['MATRIX_SYNTHETIC_MARKER']} : {env:{MATRIX_SYNTHETIC_MARKER:marker}}),startup_timeout_sec:5}});
const catalog=threadId=>request('mcpServerStatus/list',{threadId,serverName:'matrix_synthetic',limit:10});
const marker=value=>JSON.stringify(value).includes(markerB)?'B':JSON.stringify(value).includes(markerA)?'A':'missing';
// This root is safe only because the caller replaced HOME's backing mount.
async function scanDisposableHome(root) {
  let files=0,entriesSeen=0,bytes=0,markerPersisted=false;
  async function walk(path,depth=0) {
    if(depth>16)throw new Error('Synthetic persistence scan exceeded bounds');
    let entries;try{entries=await readdir(path,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const entry of entries){
      if(++entriesSeen>2048)throw new Error('Synthetic persistence scan exceeded bounds');
      const childPath=join(path,entry.name);const info=await lstat(childPath);
      if(info.isSymbolicLink())continue;
      if(info.isDirectory()){await walk(childPath,depth+1);continue;}
      if(!info.isFile())continue;
      if(++files>1024 || info.size>2*1024*1024 || (bytes+=info.size)>16*1024*1024)throw new Error('Synthetic persistence scan exceeded bounds');
      const value=await readFile(childPath);markerPersisted ||= value.includes(Buffer.from(markerA)) || value.includes(Buffer.from(markerB));
    }
  }
  await walk(root);return{markerPersisted,scannedFiles:files,scannedBytes:bytes};
}
let outcome,failure,stage="initialize",first="missing",resumed="missing",reload="missing";
try {
  await request('initialize',{clientInfo:{name:'matrix_mcp_probe',version:'1'},capabilities:{experimentalApi:true}});
  client.notify('initialized',{});
  stage='thread/start';
  const start=await request('thread/start',{cwd:scratch,config:config(markerA),sandbox:'read-only',approvalPolicy:'never'});
  const threadId=start.thread.id;
  stage='first catalog';
  first=marker(await catalog(threadId));
  stage='thread/resume';
  const resume=await request('thread/resume',{threadId,config:config(markerB),excludeTurns:true});
  stage='resumed catalog';
  resumed=marker(await catalog(resume.thread.id));
  stage='MCP reload';
  await request('config/mcpServer/reload',null);
  stage='reloaded catalog';
  reload=marker(await catalog(threadId));
  outcome={envVarsMode,first,resumed,reload,threadIdentityPreserved:resume.thread.id===threadId,noInference:true};
} catch(error){
  const safeNativeMessage=error.nativeMessage?.replaceAll(markerA,'[marker-A]').replaceAll(markerB,'[marker-B]').replaceAll(scratch,'[scratch]').replaceAll(homedir(),'[home]').slice(0,1024);
  failure={probeFailed:true,stage,method:error.method??null,code:error.code??null,reason:error.message,safeNativeMessage,first,resumed,reload,envVarsMode,noInference:true};process.exitCode=1;
}
finally{
  child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),2000);let stopDeadline;
  try{await Promise.race([closed,new Promise((_,reject)=>{stopDeadline=setTimeout(()=>reject(new Error('Synthetic native cleanup unconfirmed')),5000);})]);
    const persistence=await scanDisposableHome(join(homedir(),'.codex'));process.stdout.write(JSON.stringify({...outcome,...failure,...persistence})+'\n');
  }finally{clearTimeout(force);clearTimeout(stopDeadline);client.dispose();await rm(scratch,{recursive:true,force:true});}
}

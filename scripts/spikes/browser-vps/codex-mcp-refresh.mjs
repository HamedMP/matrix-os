/** No inference/auth calls or persistent config writes. Run in a credential-free sandbox. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir, lstat, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { SYNTHETIC_MCP_SOURCE, createProbeClient, writeSyntheticRollout, confirmProbeChildStopped } from "./codex-mcp-probe-support.mjs";
const executable = process.argv[2];
if (!executable || process.argv[3] !== "--isolated-home") throw new Error("Pass the pinned executable and --isolated-home only inside a disposable-home sandbox");
const flags=new Set(process.argv.slice(4));
const restartNative = flags.has("--restart-native");
const envVarsMode = flags.has("--env-vars") || restartNative;
const seedRollout = flags.has("--seed-rollout") || restartNative;
const markerA = `matrix_probe_marker_${randomUUID()}`;
const markerB = `matrix_probe_marker_${randomUUID()}`;
const scratch = await mkdtemp(join(tmpdir(), "matrix-codex-mcp-probe-"));
const mock = join(scratch, "mock.mjs");
await writeFile(mock, SYNTHETIC_MCP_SOURCE, { mode: 0o600 });
// HOME and credentials must be isolated by the caller. These flags do not read auth.
function startNative(value) {
  const child=spawn(executable,["-c",'mcp_servers={}',"app-server"],{cwd:scratch,env:{PATH:process.env.PATH,...(envVarsMode?{MATRIX_SYNTHETIC_MARKER:value}:{})},stdio:["pipe","pipe","ignore"]});
  const closed=new Promise(resolve=>child.once("close",resolve));const client=createProbeClient(child);return{child,closed,client};
}
let native=startNative(markerA);
const request=(method,params)=>native.client.request(method,params);
async function initialize(){await request('initialize',{clientInfo:{name:'matrix_mcp_probe',version:'1'},capabilities:{experimentalApi:true}});native.client.notify('initialized',{});}
const config=marker=>({'mcp_servers.matrix_synthetic':{command:process.execPath,args:[mock],...(envVarsMode ? {env_vars:['MATRIX_SYNTHETIC_MARKER']} : {env:{MATRIX_SYNTHETIC_MARKER:marker}}),startup_timeout_sec:5}});
const catalog=threadId=>request('mcpServerStatus/list',{threadId,serverName:'matrix_synthetic',limit:10});
const marker=value=>JSON.stringify(value).includes(markerB)?'B':JSON.stringify(value).includes(markerA)?'A':'missing';
// This root is safe only because the caller replaced HOME's backing mount.
async function scanDisposableHome(root) {
  let files=0,entriesSeen=0,bytes=0,readBytes=0,largestFileBytes=0,markerPersisted=false;
  function exceeded(limitKind){const error=new Error('Synthetic persistence scan exceeded bounds');error.limitKind=limitKind;error.counters={scannedFiles:files,scannedBytes:readBytes,inspectedBytes:bytes,largestFileBytes};throw error;}
  async function walk(path,depth=0) {
    if(depth>16)exceeded('depth');
    let entries;try{entries=await readdir(path,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const entry of entries){
      if(++entriesSeen>2048)exceeded('entries');
      const childPath=join(path,entry.name);const info=await lstat(childPath);
      if(info.isSymbolicLink())continue;
      if(info.isDirectory()){await walk(childPath,depth+1);continue;}
      if(!info.isFile())continue;
      files++;bytes+=info.size;largestFileBytes=Math.max(largestFileBytes,info.size);
      if(files>1024)exceeded('file_count');if(info.size>8*1024*1024)exceeded('file_bytes');if(bytes>16*1024*1024)exceeded('total_bytes');
      const value=await readFile(childPath);readBytes+=value.length;markerPersisted ||= value.includes(Buffer.from(markerA)) || value.includes(Buffer.from(markerB));
    }
  }
  await walk(root);return{persistenceConfirmed:true,markerPersisted,scannedFiles:files,scannedBytes:readBytes,inspectedBytes:bytes,largestFileBytes};
}
let outcome,failure,stage="initialize",first="missing",resumed="missing",reload="missing";
try {
  await initialize();
  stage='thread/start';
  const start=await request('thread/start',{cwd:scratch,config:config(markerA),sandbox:'read-only',approvalPolicy:'never'});
  const threadId=start.thread.id;
  stage='first catalog';
  first=marker(await catalog(threadId));
  if(seedRollout){stage='seed synthetic rollout';await writeSyntheticRollout({homePath:join(homedir(),'.codex'),threadId,cwd:scratch});}
  if(restartNative){
    stage='confirmed native stop';await confirmProbeChildStopped(native.child,native.closed);native.client.dispose();
    stage='fresh native initialize';native=startNative(markerB);await initialize();
  }
  stage='thread/resume';
  const resume=await request('thread/resume',{threadId,config:config(markerB),excludeTurns:true});
  stage='resumed catalog';
  resumed=marker(await catalog(resume.thread.id));
  stage='MCP reload';
  await request('config/mcpServer/reload',null);
  stage='reloaded catalog';
  reload=marker(await catalog(threadId));
  outcome={envVarsMode,seedRollout,restartNative,first,resumed,reload,threadIdentityPreserved:resume.thread.id===threadId,noInference:true};
} catch(error){
  const safeNativeMessage=error.nativeMessage?.replaceAll(markerA,'[marker-A]').replaceAll(markerB,'[marker-B]').replaceAll(scratch,'[scratch]').replaceAll(homedir(),'[home]').slice(0,1024);
  failure={probeFailed:true,stage,method:error.method??null,code:error.code??null,reason:error.message,safeNativeMessage,first,resumed,reload,envVarsMode,seedRollout,restartNative,noInference:true};process.exitCode=1;
}
finally{
  try{await confirmProbeChildStopped(native.child,native.closed);
    let persistence;
    try{persistence=await scanDisposableHome(join(homedir(),'.codex'));}
    catch(error){persistence={persistenceConfirmed:false,limitKind:error.limitKind??'scan_failed',...error.counters};process.exitCode=1;}
    process.stdout.write(JSON.stringify({...outcome,...failure,...persistence})+'\n');
  }finally{native.client.dispose();await rm(scratch,{recursive:true,force:true});}
}

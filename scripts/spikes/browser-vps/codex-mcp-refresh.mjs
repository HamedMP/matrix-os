/** No inference/auth calls or persistent config writes. Run in a credential-free sandbox. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
const executable = process.argv[2];
if (!executable || process.argv[3] !== "--isolated-home") throw new Error("Pass the pinned executable and --isolated-home only inside a disposable-home sandbox");
const envVarsMode = process.argv[4] === "--env-vars";
const markerA = `matrix_probe_marker_${randomUUID()}`;
const markerB = `matrix_probe_marker_${randomUUID()}`;
const scratch = await mkdtemp(join(tmpdir(), "matrix-codex-mcp-probe-"));
const mock = join(scratch, "mock.mjs");
await writeFile(mock, `import {createInterface} from 'node:readline';
const label=process.env.MATRIX_SYNTHETIC_MARKER;
createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(!('id' in request))return;
let result=request.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}:request.method==='tools/list'?{tools:[{name:'synthetic_marker',description:label,inputSchema:{type:'object',properties:{}}}]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');});\n`, { mode: 0o600 });
// HOME and credentials must be isolated by the caller. These flags do not read auth.
const child = spawn(executable, ["-c", 'mcp_servers={}', "app-server"], { cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(envVarsMode ? { MATRIX_SYNTHETIC_MARKER: markerA } : {}) }, stdio: ["pipe", "pipe", "ignore"] });
let next=0;const pending=new Map();const closed=new Promise(resolve=>child.once("close",resolve));
const timeout=setTimeout(()=>child.kill("SIGKILL"),45000);
createInterface({input:child.stdout}).on("line",line=>{try {const value=JSON.parse(line);const wait=pending.get(value.id);if(wait){pending.delete(value.id);value.error?wait.reject(new Error(value.error.code+':'+value.error.message)):wait.resolve(value.result);}}catch{}});
function request(method,params){return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
const config=marker=>({'mcp_servers.matrix_synthetic':{command:process.execPath,args:[mock],...(envVarsMode ? {env_vars:['MATRIX_SYNTHETIC_MARKER']} : {env:{MATRIX_SYNTHETIC_MARKER:marker}}),startup_timeout_sec:5}});
const catalog=threadId=>request('mcpServerStatus/list',{threadId,serverName:'matrix_synthetic',limit:10});
const marker=value=>JSON.stringify(value).includes(markerB)?'B':JSON.stringify(value).includes(markerA)?'A':'missing';
// This root is safe only because the caller replaced HOME's backing mount.
async function scanDisposableHome(root) {
  let files=0,bytes=0,markerPersisted=false;
  async function walk(path) {
    let entries;try{entries=await readdir(path,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const entry of entries){
      const childPath=join(path,entry.name);const info=await lstat(childPath);
      if(info.isSymbolicLink())continue;
      if(info.isDirectory()){await walk(childPath);continue;}
      if(!info.isFile())continue;
      if(++files>1024 || info.size>2*1024*1024 || (bytes+=info.size)>16*1024*1024)throw new Error('Synthetic persistence scan exceeded bounds');
      const value=await readFile(childPath);markerPersisted ||= value.includes(Buffer.from(markerA)) || value.includes(Buffer.from(markerB));
    }
  }
  await walk(root);return{markerPersisted,scannedFiles:files,scannedBytes:bytes};
}
let outcome;
try {
  await request('initialize',{clientInfo:{name:'matrix_mcp_probe',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const start=await request('thread/start',{cwd:scratch,config:config(markerA),sandbox:'read-only',approvalPolicy:'never'});
  const threadId=start.thread.id;
  const first=marker(await catalog(threadId));
  const resume=await request('thread/resume',{threadId,config:config(markerB),excludeTurns:true});
  const resumed=marker(await catalog(resume.thread.id));
  await request('config/mcpServer/reload',null);
  const reload=marker(await catalog(threadId));
  outcome={envVarsMode,first,resumed,reload,threadIdentityPreserved:resume.thread.id===threadId,noInference:true};
} catch(error){process.stdout.write(JSON.stringify({probeFailed:true,reason:error.message,noInference:true})+'\n');process.exitCode=1;}
finally{
  child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),2000);let stopDeadline;
  try{await Promise.race([closed,new Promise((_,reject)=>{stopDeadline=setTimeout(()=>reject(new Error('Synthetic native cleanup unconfirmed')),5000);})]);
    if(outcome){const persistence=await scanDisposableHome(join(process.env.HOME,'.codex'));process.stdout.write(JSON.stringify({...outcome,...persistence})+'\n');}
  }finally{clearTimeout(force);clearTimeout(stopDeadline);clearTimeout(timeout);await rm(scratch,{recursive:true,force:true});}
}

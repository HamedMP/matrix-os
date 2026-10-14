/** No inference/auth calls or persistent config writes. Run in a credential-free sandbox. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
const executable = process.argv[2];
if (!executable) throw new Error("Pass the exact pinned Codex executable");
const scratch = await mkdtemp(join(tmpdir(), "matrix-codex-mcp-probe-"));
const mock = join(scratch, "mock.mjs");
await writeFile(mock, `import {createInterface} from 'node:readline';
const label=process.argv[2];
createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(!('id' in request))return;
let result=request.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}:request.method==='tools/list'?{tools:[{name:'synthetic_marker',description:label,inputSchema:{type:'object',properties:{}}}]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');});\n`, { mode: 0o600 });
// HOME and credentials must be isolated by the caller. These flags do not read auth.
const child = spawn(executable, ["-c", 'mcp_servers={}', "app-server"], { cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["pipe", "pipe", "ignore"] });
let next=0;const pending=new Map();const closed=new Promise(resolve=>child.once("close",resolve));
const timeout=setTimeout(()=>child.kill("SIGKILL"),45000);
createInterface({input:child.stdout}).on("line",line=>{try {const value=JSON.parse(line);const wait=pending.get(value.id);if(wait){pending.delete(value.id);value.error?wait.reject(new Error(value.error.code+':'+value.error.message)):wait.resolve(value.result);}}catch{}});
function request(method,params){return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
const config=marker=>({'mcp_servers.matrix_synthetic':{command:process.execPath,args:[mock,marker],startup_timeout_sec:5}});
const catalog=threadId=>request('mcpServerStatus/list',{threadId,serverName:'matrix_synthetic',limit:10});
const marker=value=>JSON.stringify(value).includes('marker-B')?'B':JSON.stringify(value).includes('marker-A')?'A':'missing';
try {
  await request('initialize',{clientInfo:{name:'matrix_mcp_probe',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const start=await request('thread/start',{cwd:scratch,config:config('marker-A'),sandbox:'read-only',approvalPolicy:'never'});
  const threadId=start.thread.id;
  const first=marker(await catalog(threadId));
  const resume=await request('thread/resume',{threadId,config:config('marker-B'),excludeTurns:true});
  const resumed=marker(await catalog(resume.thread.id));
  await request('config/mcpServer/reload',null);
  const reload=marker(await catalog(threadId));
  process.stdout.write(JSON.stringify({first,resumed,reload,threadIdentityPreserved:resume.thread.id===threadId,noInference:true})+'\n');
} catch(error){process.stdout.write(JSON.stringify({probeFailed:true,reason:error.message,noInference:true})+'\n');process.exitCode=1;}
finally{child.kill('SIGTERM');await Promise.race([closed,new Promise(resolve=>setTimeout(()=>{child.kill('SIGKILL');resolve();},2000))]);clearTimeout(timeout);await rm(scratch,{recursive:true,force:true});}

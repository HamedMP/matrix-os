export const SYNTHETIC_MCP_SOURCE = String.raw`import {createInterface} from 'node:readline';
const label=process.env.MATRIX_SYNTHETIC_MARKER;
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);if(!('id' in request))return;
  const result=request.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}:request.method==='tools/list'?{tools:[{name:'synthetic_marker',description:label,inputSchema:{type:'object',properties:{}}}]}:{};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
`;
const METHODS=new Set(['initialize','initialized','thread/start','thread/resume','mcpServerStatus/list','config/mcpServer/reload']);
const CODES=new Set([-32700,-32600,-32601,-32602,-32603,-32000,-32001,-32002]);
function refused(method,code,message){const error=new Error('Native probe RPC refused');error.method=method;error.code=CODES.has(code)?code:'unclassified';error.nativeMessage=typeof message==='string'?message.slice(0,1024):undefined;return error;}
export function createProbeClient(child,{requestTimeoutMs=10000,totalTimeoutMs=45000}={}) {
  let next=0,unavailable=false;const pending=new Map();
  function fail(error){if(unavailable)return;unavailable=true;if(error)console.warn('[browser-vps-probe] Native transport rejected',error instanceof Error?error.name:'UnknownError');for(const value of pending.values()){clearTimeout(value.timer);value.reject(new Error('Native probe unavailable'));}pending.clear();}
  child.on('error',fail);child.on('close',()=>fail());child.stdin.on('error',fail);child.stdout.on('error',fail);
  const deadline=setTimeout(()=>{fail();child.kill('SIGKILL');},totalTimeoutMs);
  const maxLineBytes=1024*1024;let buffered=Buffer.alloc(0);
  function acceptLine(line){try{if(line.at(-1)===13)line=line.subarray(0,-1);const value=JSON.parse(line.toString('utf8'));const wait=pending.get(value.id);if(!wait)return;pending.delete(value.id);clearTimeout(wait.timer);value.error?wait.reject(refused(wait.method,value.error.code,value.error.message)):wait.resolve(value.result);}catch(error){fail(error);}}
  function onData(value){if(unavailable)return;const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);let offset=0;while(offset<chunk.length&&!unavailable){const newline=chunk.indexOf(10,offset);const end=newline<0?chunk.length:newline;const size=end-offset;if(buffered.length+size>maxLineBytes){fail(new Error('Native probe output limit exceeded'));return;}if(size>0)buffered=buffered.length===0?Buffer.from(chunk.subarray(offset,end)):Buffer.concat([buffered,chunk.subarray(offset,end)],buffered.length+size);if(newline<0)return;acceptLine(buffered);buffered=Buffer.alloc(0);offset=newline+1;}}
  child.stdout.on('data',onData);
  function notify(method,params){if(unavailable)throw new Error('Native probe unavailable');child.stdin.write(JSON.stringify({method,params})+'\n',error=>{if(error)fail(error);});}
  return{
    notify,
    request(method,params){return new Promise((resolve,reject)=>{
      if(unavailable || !METHODS.has(method) || pending.size>=8){reject(new Error('Native probe unavailable'));return;}
      const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native probe request timed out'));},requestTimeoutMs);
      pending.set(id,{resolve,reject,timer,method});child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error)fail(error);});
    });},
    dispose(){clearTimeout(deadline);fail();child.stdout.off('data',onData);buffered=Buffer.alloc(0);},
  };
}
/** Adapted from the pinned public app-server test fixture, not owner history.
 * https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/tests/common/rollout.rs
 */
export async function writeSyntheticRollout({homePath,threadId,cwd}) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(threadId))throw new Error('Invalid synthetic thread');
  const {mkdir,writeFile}=await import('node:fs/promises');const {join}=await import('node:path');
  const timestamp='2026-10-14T00:00:00Z';
  const payload={id:threadId,session_id:threadId,timestamp,cwd,originator:'codex',cli_version:'0.162.1',source:'cli',model_provider:'openai',selected_capability_roots:[],history_mode:'legacy'};
  const text='Synthetic MCP lifecycle fixture. No model turn was executed.';
  const records=[{timestamp,type:'session_meta',payload},{timestamp,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}},{timestamp,type:'event_msg',payload:{type:'user_message',message:text,kind:'plain'}}];
  const dir=join(homePath,'sessions','2026','10','14');await mkdir(dir,{recursive:true,mode:0o700});
  const path=join(dir,`rollout-2026-10-14T00-00-00-${threadId}.jsonl`);
  await writeFile(path,records.map(row=>JSON.stringify(row)).join('\n')+'\n',{flag:'wx',mode:0o600});return path;
}
export async function confirmProbeChildStopped(child,closed,{forceMs=2000,deadlineMs=5000}={}) {
  child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),forceMs);let deadline;
  try{await Promise.race([closed,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Synthetic native cleanup unconfirmed')),deadlineMs);})]);}
  finally{clearTimeout(force);clearTimeout(deadline);}
}

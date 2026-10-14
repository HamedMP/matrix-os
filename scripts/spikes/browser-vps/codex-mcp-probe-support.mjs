import { createInterface } from "node:readline";
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
function refused(method,code){const error=new Error('Native probe RPC refused');error.method=method;error.code=CODES.has(code)?code:'unclassified';return error;}
export function createProbeClient(child,{requestTimeoutMs=10000,totalTimeoutMs=45000}={}) {
  let next=0,unavailable=false;const pending=new Map();
  function fail(){unavailable=true;for(const value of pending.values()){clearTimeout(value.timer);value.reject(new Error('Native probe unavailable'));}pending.clear();}
  child.on('error',fail);child.on('close',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);
  const deadline=setTimeout(()=>{fail();child.kill('SIGKILL');},totalTimeoutMs);
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{if(Buffer.byteLength(line)>1024*1024)throw new Error('limit');const value=JSON.parse(line);const wait=pending.get(value.id);if(!wait)return;pending.delete(value.id);clearTimeout(wait.timer);value.error?wait.reject(refused(wait.method,value.error.code)):wait.resolve(value.result);}catch{fail();}});
  function notify(method,params){if(unavailable)throw new Error('Native probe unavailable');child.stdin.write(JSON.stringify({method,params})+'\n',error=>{if(error)fail();});}
  return{
    notify,
    request(method,params){return new Promise((resolve,reject)=>{
      if(unavailable || !METHODS.has(method) || pending.size>=8){reject(new Error('Native probe unavailable'));return;}
      const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native probe request timed out'));},requestTimeoutMs);
      pending.set(id,{resolve,reject,timer,method});child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error)fail();});
    });},
    dispose(){clearTimeout(deadline);fail();lines.close();},
  };
}

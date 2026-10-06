import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

/** Public version-only qualification, before a login choice is advertised. */
export async function supportsCodexTerminalLogin(runtimePrefix: string): Promise<boolean> {
  try {
    const result = await promisify(execFile)(join(runtimePrefix, "bin/codex"), ["--version"], {
      timeout: 5000, maxBuffer: 4096, encoding: "utf8", windowsHide: true,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    return result.stdout.trim() === `codex-cli ${CODEX_VERIFIED_VERSION}`;
  } catch (error) {
    console.warn("[provider-workflow] Codex Terminal protocol unavailable:", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

/** Fixed, dependency-free Terminal helper for the qualified official Codex CLI.
 * Uses the same native account RPC as Settings; never runs the destructive
 * `codex login` command, reads credentials or implements an OAuth client.
 * Embedded in the command so host bundles need no untracked script file.
 */
export const CODEX_TERMINAL_LOGIN_WORKER = String.raw`
import { spawn, execFileSync } from "node:child_process";
const version = ${JSON.stringify(`codex-cli ${CODEX_VERIFIED_VERSION}`)};
try {
  if (execFileSync("codex", ["--version"], {encoding:"utf8",timeout:5000,maxBuffer:4096,stdio:["ignore","pipe","pipe"]}).trim() !== version) throw new Error("unsupported");
} catch (error) {
  console.error("[provider-workflow] Native version unavailable:", error instanceof Error ? "runtime_failure" : "unexpected_failure");
  console.log("Codex sign-in is unavailable on this Computer.");
  process.exit(1);
}
const child = spawn("codex", ["app-server", "--stdio"], {stdio:["pipe","pipe","pipe"]});
let buffer="", bytes=0, loginId=null, stopping=false, closed=false, success=false, finalized=false, initialized=false, authorizationReceived=false;
let force, cancelTimer, cancelAck;
const send = (id,method,params) => {
  if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify({id,method,params})+"\n");
};
const ended = () => {
  if(finalized)return; finalized=true;
  clearTimeout(startup); clearTimeout(deadline); clearTimeout(force); clearTimeout(cancelTimer);
  buffer="";
  console.log(success ? "Codex sign-in completed." : "Codex sign-in was not completed.");
  process.exitCode=success ? 0 : 1;
};
const finish = async ok => {
  if (stopping) return;
  stopping=true; success=ok;
  clearTimeout(startup); clearTimeout(deadline); buffer="";
  if (closed) { ended(); return; }
  if (!ok && loginId) {
    await new Promise(resolve => {
      cancelAck=resolve; cancelTimer=setTimeout(resolve,250);
      send(3,"account/login/cancel",{loginId});
    });
    clearTimeout(cancelTimer);
  }
  if (closed) { ended(); return; }
  child.kill("SIGTERM");
  force=setTimeout(()=>child.kill("SIGKILL"),1000);
};
const startup=setTimeout(()=>void finish(false),30000);
const deadline=setTimeout(()=>void finish(false),600000);
process.on("SIGTERM",()=>void finish(false));
process.on("SIGINT",()=>void finish(false));
child.stdin.on("error",()=>void finish(false));
child.on("error",()=>void finish(false));
child.on("close",()=>{closed=true; if(stopping) ended(); else void finish(false);});
child.stderr.on("data",chunk=>{bytes+=chunk.length;if(bytes>65536)void finish(false);});
child.stdout.setEncoding("utf8");
child.stdout.on("data",chunk=>{
  bytes+=Buffer.byteLength(chunk); if(bytes>65536){void finish(false);return;}
  if(stopping){
    // A cancellation acknowledgement is optional; its contents are never shown.
    try { for(const line of chunk.split("\n"))if(line&&JSON.parse(line)?.id===3)cancelAck?.(); } catch (error) { buffer=""; if(!(error instanceof SyntaxError))void finish(false); }
    return;
  }
  buffer+=chunk;
  let newline;
  while((newline=buffer.indexOf("\n"))>=0){
    const line=buffer.slice(0,newline); buffer=buffer.slice(newline+1);
    let message;
    try{message=JSON.parse(line);}catch(error){console.error("[provider-workflow] Invalid native response:",error instanceof SyntaxError?"invalid_json":"unexpected_failure");void finish(false);return;}
    if(!message||typeof message!=="object"||Array.isArray(message)){void finish(false);return;}
    if(message.id===1){
      if(initialized||message.error||!message.result||typeof message.result!=="object"){void finish(false);return;}
      initialized=true;
      child.stdin.write(JSON.stringify({method:"initialized",params:{}})+"\n");
      send(2,"account/login/start",{type:"chatgptDeviceCode"});
    }else if(message.id===2){
      if(!initialized||authorizationReceived){void finish(false);return;}
      authorizationReceived=true;
      const result=message.result;
      if(message.error||!result||result.type!=="chatgptDeviceCode"||typeof result.loginId!=="string"||!result.loginId||result.loginId.length>128||
        result.verificationUrl!=="https://auth.openai.com/codex/device"||typeof result.userCode!=="string"||!(/^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/).test(result.userCode)){void finish(false);return;}
      loginId=result.loginId; clearTimeout(startup);
      console.log("Open https://auth.openai.com/codex/device\nEnter code "+result.userCode+"\nWaiting for official Codex sign-in. Press Ctrl+C to cancel.");
    }else if(message.method==="account/login/completed"&&loginId&&message.params?.loginId===loginId){
      void finish(message.params.success===true);return;
    }
  }
});
send(1,"initialize",{clientInfo:{name:"matrix-os-settings",version:"1.0.0"},capabilities:{}});
`;

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export const CODEX_TERMINAL_LOGIN_COMMAND = `sh -lc ${quote('export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"; export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"; exec "$MATRIX_NODE_PREFIX/bin/node" --input-type=module --eval ' + quote(CODEX_TERMINAL_LOGIN_WORKER))}`;

import { codexNativeEnvironment } from "./codex-native-environment.js";
import { constants, accessSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function resolveCodexNativeExecutable(homePath: string, environment = buildAgentRuntimeEnvironment(homePath)): string {
  const candidates = [join(environment.MATRIX_NODE_PREFIX ?? "/opt/matrix/runtime/node", "bin/codex"),
    ...(environment.PATH ?? "").split(delimiter).filter(isAbsolute).map(directory => join(directory, "codex"))];
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) throw error;
    }
  }
  throw new Error("Native Codex executable is unavailable");
}

/** Owner-visible official CLI only. Never replace a key or uncertain credential state. */
export function codexNativeTerminalCommand(homePath: string, input?: { executable: string; environment?: Record<string, string> }): string {
  const environment = input?.environment ?? buildAgentRuntimeEnvironment(homePath);
  const executable = input?.executable ?? resolveCodexNativeExecutable(homePath, environment);
  const env = codexNativeEnvironment(homePath, environment, input?.environment?.CODEX_HOME ?? process.env.CODEX_HOME);
  // The status protocol is the same exact bounded local protocol as agent-launcher.
  // A logged-in ChatGPT account is reused, then privately verified by completion.
  // An explicit owner sign-out is required before replacing another account/key.
  const script = `const {spawnSync,spawn}=require('node:child_process');
const executable=${JSON.stringify(executable)}, env=${JSON.stringify(env)};
const status=spawnSync(executable,['login','status'],{cwd:${JSON.stringify(homePath)},env,encoding:'utf8',timeout:10000,maxBuffer:16384});
const text=[status.stdout,status.stderr].filter(v=>typeof v==='string').join('\\n').trim();
if(!status.error && status.status===0 && text==='Logged in using ChatGPT') process.exit(0);
if(status.error || status.status!==1 || text!=='Not logged in') { console.error('Sign out of the existing Codex account before connecting a different subscription.'); process.exit(1); }
const child=spawn(executable,['login','--device-auth'],{cwd:${JSON.stringify(homePath)},env,stdio:'inherit'});
child.on('error',()=>process.exit(1));child.on('exit',(code)=>process.exit(code??1));
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));`;
  // Clean the wrapper too: Node reads NODE_OPTIONS before executing this script.
  const assignments = Object.entries(env).map(([key, value]) => quote(`${key}=${value}`)).join(" ");
  return `exec /usr/bin/env -i ${assignments} ${quote(process.execPath)} -e ${quote(script)}`;
}

import { randomUUID } from "node:crypto";
import { open, lstat, unlink } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { dirname } from "node:path";
import { assert } from "./control.mjs";
const OWNED_COMMAND_ROLES = ["owned_peer_command_0", "owned_peer_command_1"];
function connectionReason(error) {
  return ["ECONNREFUSED", "ENOENT", "EACCES", "EPERM", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(error?.code)
    ? error.code.toLowerCase() : "unknown";
}
export async function hostConnection(target, role = "owned_tcp") {
  assert([...OWNED_COMMAND_ROLES, "owned_tcp"].includes(role), "positive_control_role_invalid");
  return new Promise((resolve, reject) => {
    let socket, settled = false;
    const timer = setTimeout(() => finish("timeout"), 2000);
    const finish = reason => {
      if (settled) return; settled = true; clearTimeout(timer); socket?.destroy();
      reason ? reject(Error(`positive_control_${role}_${reason}`)) : resolve(true);
    };
    try { socket = createConnection(target); } catch (error) { finish(connectionReason(error)); return; }
    socket.once("connect", () => finish()); socket.once("error", error => finish(connectionReason(error)));
  });
}
export async function startControls(config, baseline, peerSockets, check = () => {}) {
  assert(Array.isArray(peerSockets) && peerSockets.length === 2 && peerSockets[0] !== peerSockets[1], "owned_command_controls_missing");
  const targets = peerSockets.map((path, index) => ({ path, role: OWNED_COMMAND_ROLES[index] }));
  for (const role of ["legacy_ipc", "legacy_command", "peer_ipc", "peer_command"]) {
    const entry = Object.entries(baseline.sockets).find(([, value]) => value.role === role);
    if (entry) targets.push({ path: entry[0], role });
  }
  assert(targets.some(item => item.role === "legacy_ipc"), "required_legacy_endpoint_missing");
  const socketEvidence = [];
  for (const target of targets) {
    check();
    let metadata;
    try { metadata = await lstat(target.path); }
    catch (error) { throw Error(`positive_control_${target.role}_${connectionReason(error)}`); }
    assert(metadata.isSocket(), `positive_control_${target.role}_not_socket`);
    // A successful empty connection permanently claims a worker's command slot.
    // Only our two disposable command workers may be consumed by positives.
    // Installed/foreign IPC and command listeners may be stale; never probe them.
    const connected = OWNED_COMMAND_ROLES.includes(target.role);
    if (connected) await hostConnection({ path: target.path }, target.role);
    socketEvidence.push({ ...target, connected, evidence: connected ? "connected" : "metadata_only",
      inode: metadata.ino, device: metadata.dev });
  }
  check();
  const path = `${dirname(config.appRoot)}/.boundary-${randomUUID()}`; const file = await open(path, "wx", 0o600);
  await file.writeFile("synthetic native boundary fixture\n"); const identity = await file.stat(); await file.close();
  const sockets = new Set(); const server = createServer(socket => {
    if (sockets.size >= 8) { socket.destroy(); return; } sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 1000);
    socket.on("error", () => socket.destroy()); socket.once("close", () => { clearTimeout(timer); sockets.delete(socket); }); socket.end("control-ok\n");
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    const current = await lstat(path); assert(current.ino === identity.ino && current.dev === identity.dev, "control_file_ownership_lost"); await unlink(path);
    return { state: "passed", exactOwnedResources: true };
  };
  try {
    check();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert(address && typeof address === "object", "positive_tcp_unavailable");
    await hostConnection({ host: "127.0.0.1", port: address.port });
    return { targets, filePath: path, port: address.port, hostPositive: { tcp: true, sockets: socketEvidence, syntheticFilePresent: true }, close };
  } catch (error) { await close(); throw error; }
}
// Only fixed fixture data and endpoint names are inputs. No credentials or
// environments are read; a timeout/unknown errno is a failure, never a denial.
// Self-contained so the pinned worker executable can use it inside its root.
export async function fileReadResult(path, fs) {
  try { await fs.access(path, fs.constants.R_OK); return { path, code: "READABLE" }; }
  catch (error) { return { path, code: error.code }; }
}
export const DENIAL_PROBE = `
import * as fs from 'node:fs/promises'; const {readFile}=fs; import {connect} from 'node:net'; import {networkInterfaces} from 'node:os';
const input=JSON.parse(process.argv[1]);
const attempt=target=>new Promise(resolve=>{const s=connect(target);let done=false;const timer=setTimeout(()=>finish('TIMEOUT'),1500);const finish=code=>{if(done)return;done=true;clearTimeout(timer);s.destroy();resolve(code)};s.once('connect',()=>finish('CONNECTED'));s.once('error',e=>finish(e.code));});
const unix=[];for(const target of input.targets)unix.push({role:target.role,path:target.path,code:await attempt({path:target.path})});
const fileReadResult=${fileReadResult.toString()};
const files=[];for(const path of [input.filePath,'/opt/matrix/env/host.env','/home/matrix/home','/root'])files.push(await fileReadResult(path,fs));
const broker=await new Promise((resolve,reject)=>{const s=connect({path:'/run/matrix-scope/broker.sock'});let text='';const t=setTimeout(()=>{s.destroy();reject(Error('broker_control_timeout'))},2000);s.once('connect',()=>s.end(JSON.stringify({version:1,requestId:'boundary-positive',action:'inference.messages',method:'HEAD',path:'/api/hello'})+'\\n'));s.on('data',b=>{text+=b;if(text.length>4096)s.destroy()});s.once('error',reject);s.once('end',()=>{clearTimeout(t);s.destroy();try{const r=JSON.parse(text);resolve(r.ok===true&&r.status===200)}catch(e){reject(e)}})});
const ipv4=(await readFile('/proc/self/net/route','utf8')).trim().split('\\n').slice(1).filter(Boolean).every(line=>line.trim().split(/\\s+/)[0]==='lo');
const ipv6=(await readFile('/proc/self/net/ipv6_route','utf8')).trim().split('\\n').filter(Boolean).every(line=>line.trim().split(/\\s+/).at(-1)==='lo');
console.log(JSON.stringify({unix,files,tcp:await attempt({host:'127.0.0.1',port:input.port}),brokerPositive:broker,noExternalInterface:Object.values(networkInterfaces()).flat().every(v=>v.internal),noExternalRoute:ipv4&&ipv6}));
`;
export function validateDenials(result, controls) {
  assert(result?.brokerPositive === true && result.noExternalInterface === true && result.noExternalRoute === true, "worker_positive_or_route_control_failed");
  assert(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EACCES"].includes(result.tcp), "worker_tcp_not_denied");
  assert(Array.isArray(result.unix) && result.unix.length === controls.targets.length && result.unix.every((item, index) => item.path === controls.targets[index].path && item.role === controls.targets[index].role && ["ENOENT", "EACCES"].includes(item.code)), "worker_peer_socket_not_denied");
  const paths = [controls.filePath, "/opt/matrix/env/host.env", "/home/matrix/home", "/root"];
  assert(Array.isArray(result.files) && result.files.length === paths.length && result.files.every((item, index) => item.path === paths[index] && ["ENOENT", "EACCES"].includes(item.code)), "worker_file_not_denied");
  return { unix: result.unix.map(item => ({ path: item.path, role: item.role, code: item.code })), files: result.files.map(item => ({ path: item.path, code: item.code })), tcp: result.tcp, brokerPositive: true, noExternalInterface: true, noExternalRoute: true };
}

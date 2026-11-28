/** Temporary synthetic Main qualification guardian. Never registered with Gateway. */
import http from 'node:http';
import net from 'node:net';
import { lookup as resolveDns } from 'node:dns/promises';
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, readdir, writeFile, chmod } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { createQualificationMcpServer, createQualificationStdioTransport, stopOnTransportLoss } from '../mcp.mjs';
import { MainIsolatedGrant } from '../contracts.mjs';

const fail = () => new Error('qualification_unavailable');
const startupPhases = new Set(['preflight','viewer_credentials','xvnc','isolation_receipt','desktop_apps','viewer_relay','running']);
const startupCodes = new Set(['unsupported_option','missing_shared_library','sandbox_unavailable','socket_binding','display_lock','font_unavailable','xkb_unavailable','permission_denied','missing_runtime_file','viewer_authentication','resource_limit','invalid_executable','unclassified']);
const startupServices = new Set(['xvnc','openbox','panel','chrome']);
function startupDiagnostic(value) {
  if(!startupServices.has(value?.service)||!startupCodes.has(value.code))return;
  const safe={service:value.service,code:value.code};
  for(const [key,lower,upper] of [['exit_code',-255,255],['stderr_bytes',0,65536],['errno',1,4095]]){
    if(Number.isInteger(value[key])&&value[key]>=lower&&value[key]<=upper)safe[key]=value[key];
  }
  if(typeof value.truncated==='boolean')safe.truncated=value.truncated;
  return safe;
}
export function sandboxReadiness(value) {
  if(value?.ready===true&&value.receipt)return value.receipt;
  const error=fail();
  if(startupPhases.has(value?.phase))error.phase=value.phase;
  const diagnostic=startupDiagnostic(value?.diagnostic);
  if(diagnostic)error.diagnostic=diagnostic;
  throw error;
}
export function reportGuardianFailure(error) {
  const name=error instanceof Error&&['Error','TypeError','RangeError','SyntaxError','AbortError'].includes(error.name)?error.name:'UnknownError';
  console.warn('[computer-qualification] guardian_failed',name,startupPhases.has(error?.phase)?error.phase:'',startupDiagnostic(error?.diagnostic)??'');
}
const report=reportGuardianFailure;
const deadline = (work, ms = 8000) => {
  let timer;
  return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), ms); })]).finally(() => clearTimeout(timer));
};

/** Owner events have no path through MCP. One grant, no reconnect/resume. */
export function createOwnerController({ createSession, now = Date.now, onStop = async () => {} }) {
  let phase = 'waiting_owner', viewer = false, visibleAt = -Infinity, session, creating, stopping, handover;
  const present = () => viewer && now() - visibleAt <= 5000;
  const stop = () => {
    if (stopping) return stopping;
    phase = 'stopped';
    stopping = (async () => {
      try { if (creating) await creating; if (session) await session.stop(); }
      finally { await onStop(); }
    })();
    return stopping;
  };
  return {
    status: () => ({ phase, viewer, ownerPresent: present() }),
    viewerConnected() { if (viewer) throw fail(); viewer = true; },
    viewerDisconnected() { viewer = false; return phase === 'active' || phase === 'enabling' ? stop() : Promise.resolve(); },
    heartbeat(visible) { if (visible === true) visibleAt = now(); else visibleAt = -Infinity; },
    async enable() {
      if (phase !== 'waiting_owner') throw fail();
      if (!present()) throw new Error('owner_not_present');
      phase = 'enabling';
      creating = (async () => { session = await createSession(); })();
      try {
        await creating;
        if (phase !== 'enabling' || !present()) throw fail();
        await session.setHumanControl(false);
        if (phase !== 'enabling' || !present()) throw fail();
        session.presence(); phase = 'active';
      } catch (error) { await stop(); throw error; }
    },
    async execute(action, signal) {
      if (phase !== 'active' || !present()) { if (phase === 'active') await stop(); throw fail(); }
      return session.execute(action, signal);
    },
    async tick() {
      if (phase !== 'active') return;
      if (!present()) return stop();
      try { session.presence(); } catch (error) { await stop(); throw error; }
    },
    takeOver() {
      if (handover) return handover;
      if (phase !== 'active') return Promise.reject(fail());
      phase = 'draining';
      handover = (async () => {
        try {
          await session.stop();
          if (stopping) throw fail();
          await session.setHumanControl(true);
          if (stopping) throw fail();
          phase = 'human';
        } catch (error) { await stop(); throw error; }
      })();
      return handover;
    },
    stop,
  };
}

const denied = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) denied.addSubnet(address,prefix,'ipv6');
const globalV6 = new net.BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
export function isPublicAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? !denied.check(address,'ipv4') : family === 6 && globalV6.check(address,'ipv6') && !denied.check(address,'ipv6');
}
const limitStream = (bytes = 8 * 1024 * 1024) => new Transform({ transform(chunk, _encoding, done) {
  bytes -= chunk.length; done(bytes < 0 ? fail() : null, bytes < 0 ? undefined : chunk);
} });
function boundedPipe(source, target, bytes) {
  const limiter = limitStream(bytes);
  limiter.on('error', () => { source.destroy(); target.destroy(); });
  source.on('error', () => target.destroy()); target.on('error', () => source.destroy());
  source.pipe(limiter).pipe(target);
}
function trackConnections(server, cap = 16) {
  const sockets = new Set();
  server.maxConnections = cap;
  server.on('connection', socket => {
    if (sockets.size >= cap) { socket.destroy(); return; }
    sockets.add(socket); socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(8000, () => socket.destroy());
  });
  return () => { for (const socket of sockets) socket.destroy(); sockets.clear(); };
}

/** Plain HTTP methods checked; CONNECT restricts host/port, not encrypted inner methods. */
export function createAllowedProxy({ lookup = name => resolveDns(name,{all:true}), dial = target => net.connect(target) } = {}) {
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 8000, headersTimeout: 8000 });
  const drain = trackConnections(server); let active = 0, closed = false;
  const outgoing = new Set();
  const approved = async (raw, connect) => {
    const url = new URL(connect ? `https://${raw}` : raw);
    if (closed || raw.length > 2048 || url.username || url.password || url.hash || url.hostname !== 'example.com' ||
      (connect ? raw !== 'example.com:443' : url.protocol !== 'http:' || url.port && url.port !== '80')) throw fail();
    const answers = await deadline(lookup('example.com'));
    if (!Array.isArray(answers) || !answers.length || answers.length > 32 || answers.some(a => !isPublicAddress(a.address))) throw fail();
    return { url, target: { host: answers[0].address, family: net.isIP(answers[0].address), port: connect ? 443 : 80 } };
  };
  function remember(socket) {
    if (closed || outgoing.size >= 16) { socket.destroy(); throw fail(); }
    outgoing.add(socket); socket.once('close',()=>outgoing.delete(socket)); socket.on('error',()=>socket.destroy());
    socket.setTimeout(8000,()=>socket.destroy()); const timer=setTimeout(()=>socket.destroy(),30000);
    socket.once('close',()=>clearTimeout(timer));return socket;
  }
  server.on('request', async (req, res) => {
    if (active >= 16 || !['GET','HEAD'].includes(req.method) || req.headers['transfer-encoding'] || req.headers['content-length'] && req.headers['content-length'] !== '0' || req.headers.authorization || req.headers['proxy-authorization']) { res.writeHead(403);res.end();return; }
    active++;
    try {
      const {url,target}=await approved(req.url,false);
      if (req.destroyed || closed) throw fail();
      const headers={host:'example.com',connection:'close'};
      for(const key of ['accept','accept-language','user-agent'])if(typeof req.headers[key]==='string')headers[key]=req.headers[key];
      const agent=new http.Agent({keepAlive:false});agent.createConnection=()=>remember(dial(target));
      const upstream=http.request({host:'example.com',port:80,path:url.pathname+url.search,method:req.method,headers,agent,timeout:8000},reply=>{
        const clean={};for(const key of ['content-type','content-length','location','cache-control'])if(reply.headers[key])clean[key]=reply.headers[key];
        res.writeHead(reply.statusCode??502,clean);boundedPipe(reply,res);
      });
      upstream.once('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
      res.once('close',()=>{upstream.destroy();agent.destroy();});upstream.end();
    } catch(error) { report(error);res.writeHead(403);res.end(); }
    finally { active--; }
  });
  server.on('connect', async (req, socket, head) => {
    if(active>=16 || req.headers.authorization || req.headers['proxy-authorization']){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    active++;
    try {
      const {target}=await approved(req.url,true);if(socket.destroyed || closed)throw fail();
      const upstream=remember(dial(target));upstream.once('error',()=>socket.destroy());socket.once('close',()=>upstream.destroy());
      const timer=setTimeout(()=>upstream.destroy(),8000);
      upstream.once('connect',()=>{clearTimeout(timer);socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);boundedPipe(socket,upstream);boundedPipe(upstream,socket);});
      upstream.once('close',()=>{clearTimeout(timer);socket.destroy();});
    } catch(error) { report(error);socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
    finally { active--; }
  });
  server.on('clientError',(_error,socket)=>socket.destroy());
  return {
    async listen(path){await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(path,()=>{server.removeListener('error',reject);resolveListen();});});await chmod(path,0o600);},
    async close(){closed=true;drain();for(const socket of outgoing)socket.destroy();outgoing.clear();if(server.listening)await new Promise(done=>server.close(done));},
  };
}

async function privateDirectory(path, create = false) {
  if(create)await mkdir(path,{mode:0o700});
  const stat=await lstat(path);
  if(!isAbsolute(path)||await realpath(path)!==path||!stat.isDirectory()||stat.uid!==process.getuid()||stat.mode&0o077)throw fail();
}
async function privateJson(path,maxBytes=4096) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid()||stat.mode&0o077||stat.size>maxBytes)throw fail();
    const buffer=Buffer.alloc(maxBytes+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>maxBytes)throw fail();
    return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
  }finally{await file.close();}
}
export async function verifyManifest(bundlePath) {
  if(!isAbsolute(bundlePath)||await realpath(bundlePath)!==bundlePath)throw fail();
  const manifest=await privateJson(join(bundlePath,'manifest.json'),1024*1024);
  if(manifest.version!==1||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>4096)throw fail();
  const entries=new Map();let total=0;
  for(const entry of manifest.files){
    if(!entry||!/^(code|deps)\/[a-zA-Z0-9._/-]+$/.test(entry.path)||entry.path.split('/').includes('..')||entries.has(entry.path)||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0)throw fail();
    total+=entry.size;if(total>64*1024*1024)throw fail();entries.set(entry.path,entry);
  }
  let visited=0;
  async function walk(relative){
    const directory=await lstat(join(bundlePath,relative));if(!directory.isDirectory()||directory.isSymbolicLink()||directory.mode&0o022)throw fail();
    for(const name of await readdir(join(bundlePath,relative))){
      const path=join(relative,name),stat=await lstat(join(bundlePath,path));
      if(stat.mode&0o022||stat.isSymbolicLink())throw fail();
      if(stat.isDirectory()){await walk(path);continue;}
      const expected=entries.get(path);if(!stat.isFile()||!expected||stat.size!==expected.size)throw fail();
      const file=await open(join(bundlePath,path),constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const hash=createHash('sha256');for await(const bytes of file.createReadStream())hash.update(bytes);if(hash.digest('hex')!==expected.sha256)throw fail();}finally{await file.close();}
      visited++;
    }
  }
  await walk('code');await walk('deps');if(visited!==entries.size)throw fail();return manifest;
}

/** Static code loaded into the owner origin must come from trusted host assets. */
export async function loadViewerAsset(root,requestPath) {
  if(!isAbsolute(root)||await realpath(root)!==root)throw fail();
  const raw=new URL(requestPath,'http://qualification').pathname;
  if(!raw.startsWith('/viewer/'))throw fail();
  const relative=decodeURIComponent(raw.slice(8))||'index.html';
  if(relative.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\x00]/.test(relative))throw fail();
  const path=join(root,relative);
  if(await realpath(path)!==path)throw fail();
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await file.stat(),max=8*1024*1024;
    if(!stat.isFile()||stat.mode&0o022||stat.size>max)throw fail();
    const data=Buffer.alloc(stat.size+1),{bytesRead}=await file.read(data,0,data.length,0);
    if(bytesRead!==stat.size)throw fail();
    const extension=path.slice(path.lastIndexOf('.')).toLowerCase();
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm'};
    return {data:data.subarray(0,bytesRead),contentType:types[extension]??'application/octet-stream'};
  }finally{await file.close();}
}

function sandboxProcess(bundlePath,statePath,password) {
  const child=spawn('/usr/bin/python3',['-I',join(bundlePath,'code/isolation/sandbox.py'),'--bundle',bundlePath,'--state',statePath],{
    env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',MATRIX_QUAL_VIEWER_PASSWORD:password},stdio:['ignore','pipe','pipe'],detached:true,
  });
  let buffer='',errorBytes=0,settled=false,termination;
  const terminate=()=>termination??=(async()=>{
    if(child.exitCode!==null||child.signalCode!==null)return;
    const exited=new Promise(done=>child.once('exit',done));
    try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
    const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')report(error);}},1000);
    try{await deadline(exited,2000);}finally{clearTimeout(timer);}
  })();
  const ready=deadline(new Promise((done,reject)=>{
    child.once('error',reject);child.once('exit',()=>reject(fail()));
    child.stdout.on('data',bytes=>{
      if(settled){void terminate().catch(report);return;}buffer+=bytes.toString('utf8');if(buffer.length>8192){reject(fail());return;}
      if(buffer.includes('\n')){try{const value=JSON.parse(buffer.trim());const receipt=sandboxReadiness(value);settled=true;done(receipt);}catch(error){reject(error);}}
    });
    child.stderr.on('data',bytes=>{errorBytes+=bytes.length;if(errorBytes>8192)reject(fail());});
  }),60000);
  return {child,ready,terminate};
}

function page(csrf,grant,captureEvidence) {
  const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  return `<!doctype html><meta charset="utf-8"><title>Isolated Computer Use qualification</title>
<h1>Isolated Main test desktop</h1><p>Target: ${escape(grant.targetId)} isolated X7 · model route: ${escape(grant.modelRoute)} through existing Codex connection · expires ${escape(new Date(grant.expiresAt).toISOString())}.</p>
<p>Only synthetic example.com and the approved harmless Terminal printf test. Screenshots go to the selected model through Codex; provider retention follows that connection. Existing Main Browser/VNC/profile are separate. ${captureEvidence?'Opt-in QA: at most 24 synthetic PNGs retained in owner scratch evidence, deletion due in seven days.':'Guardian saves no screenshots.'}</p>
<button id="enable">Enable model control</button> <button id="takeover">Take over</button> <button id="stop">Stop test</button><pre id="status">Waiting for owner</pre>
<iframe id="viewer" title="Isolated synthetic desktop" style="width:100%;height:75vh;border:1px solid"></iframe>
<script>
const csrf=${JSON.stringify(csrf)},base=new URL('./',location.href);let busy=false,connected=false;
const status=document.getElementById('status');
async function post(action,body={}){const r=await fetch(new URL('__qual/'+action,base),{method:'POST',headers:{'Content-Type':'application/json','X-Qualification-CSRF':csrf},body:JSON.stringify(body)});const data=await r.json();status.textContent=JSON.stringify(data);if(!r.ok)throw Error('unavailable');return data;}
for(const action of ['enable','takeover','stop'])document.getElementById(action).onclick=()=>post(action).catch(()=>{status.textContent='Unavailable; test cannot resume';});
const v=new URL('viewer/',base),ws=new URL('viewer/websockify',base);v.searchParams.set('path',ws.pathname.slice(1));v.searchParams.set('autoconnect','true');v.searchParams.set('resize','scale');document.getElementById('viewer').src=v;
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==document.getElementById('viewer').contentWindow||event.data?.type!=='matrix-qualification-viewer'||typeof event.data.connected!=='boolean')return;connected=event.data.connected;void post('presence',{visible:connected&&document.visibilityState==='visible'}).catch(()=>{status.textContent='Disconnected/stopped';});});
setInterval(async()=>{if(busy)return;busy=true;try{await post('presence',{visible:connected&&document.visibilityState==='visible'});}catch{status.textContent='Disconnected/stopped';}finally{busy=false;}},1000);
document.addEventListener('visibilitychange',()=>{void post('presence',{visible:connected&&document.visibilityState==='visible'}).catch(()=>{status.textContent='Disconnected/stopped';});});
</script>`;
}

// Same installed-Kasm transport-state observation as browser-lab/viewer-bridge.ts.
const viewerBridge=`const notify=()=>parent.postMessage({type:'matrix-qualification-viewer',connected:document.documentElement.classList.contains('noVNC_connected')},location.origin);const observer=new MutationObserver(notify);observer.observe(document.documentElement,{attributes:true,attributeFilter:['class']});notify();addEventListener('pagehide',()=>{observer.disconnect();parent.postMessage({type:'matrix-qualification-viewer',connected:false},location.origin);},{once:true});`;

/** Only this trusted process can renew owner presence or change VNC input authority. */
export async function startGuardian({bundlePath,statePath,captureEvidence=false,ownerOrigin=process.env.MATRIX_QUAL_OWNER_ORIGIN,signal}) {
  if(process.platform!=='linux'||process.getuid()!==999)throw fail();
  if(!isAbsolute(statePath)||!isAbsolute(bundlePath)||statePath===bundlePath||statePath.startsWith(bundlePath+'/')||bundlePath.startsWith(statePath+'/'))throw fail();
  await privateDirectory(statePath);await privateDirectory(join(statePath,'host'));
  await privateDirectory(join(statePath,'desktop'),true);await verifyManifest(bundlePath);
  const grant=MainIsolatedGrant.parse(await privateJson(join(statePath,'host/grant.json')));
  const actualTarget={ownerId:process.env.MATRIX_CLERK_USER_ID,targetId:process.env.MATRIX_HANDLE};
  if(process.env.MATRIX_RUNTIME_SLOT!=='primary'||!actualTarget.ownerId||!actualTarget.targetId||grant.ownerId!==actualTarget.ownerId||grant.targetId!==actualTarget.targetId||grant.expiresAt<=Date.now()||grant.expiresAt>Date.now()+600000)throw fail();
  if(ownerOrigin){const url=new URL(ownerOrigin);if(url.origin!==ownerOrigin||!(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw fail();}
  const password=randomBytes(24).toString('hex'),csrf=randomBytes(24).toString('hex'),cookie=randomBytes(24).toString('hex');
  const basic='Basic '+Buffer.from('matrix-qualification:'+password).toString('base64');
  const proxy=createAllowedProxy();let capsule,viewer,mcp,timer,expiry,server,client,receipt,port,evidenceCount=0,metadataCount=0,shutdownPromise;
  const wsConnections=new Set();
  const shutdown=()=>shutdownPromise??=(async()=>{
    clearInterval(timer);clearTimeout(expiry);
    try{await capsule?.terminate();}finally{
      for(const connection of wsConnections)connection.destroy();wsConnections.clear();client?.destroy();
      // Permit an in-flight Stop response to finish after child/input drain.
      if(viewer?.listening){viewer.close();viewer.closeIdleConnections();const closeTimer=setTimeout(()=>viewer.closeAllConnections(),250);closeTimer.unref();}
      const closing=[];if(mcp?.listening)closing.push(new Promise(done=>mcp.close(done)));
      if(server)closing.push(server.close());closing.push(proxy.close());await Promise.allSettled(closing);
    }
  })();
  const controller=createOwnerController({onStop:shutdown,createSession:async()=>{
    const {createMainIsolatedSession}=await import('./backend.mjs');
    return createMainIsolatedSession({grant,receipt,bundlePath,statePath,actualTarget});
  }});
  const stop=()=>controller.stop();
  const abort=()=>{void stop().catch(report);};signal?.addEventListener('abort',abort,{once:true});
  try{
    if(signal?.aborted)throw fail();
    if(captureEvidence)await privateDirectory(join(statePath,'host/evidence'),true);
    await proxy.listen(join(statePath,'desktop/proxy.sock'));if(signal?.aborted)throw fail();capsule=sandboxProcess(bundlePath,statePath,password);receipt=await capsule.ready;
    capsule.child.once('exit',()=>{void stop().catch(report);});
    const expectedCookie='qualification_owner='+cookie;
    const same=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
    const hostAllowed=req=>req.headers.host===`127.0.0.1:${port}`||Boolean(ownerOrigin&&req.headers.host===new URL(ownerOrigin).host);
    const authorized=req=>hostAllowed(req)&&req.headers.cookie?.split('; ').some(part=>same(part,expectedCookie));
    const validOrigin=req=>req.headers.origin===(ownerOrigin??`http://127.0.0.1:${port}`);
    viewer=http.createServer({maxHeaderSize:8192,requestTimeout:8000,headersTimeout:8000},async(req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      if(!hostAllowed(req)){res.writeHead(403);res.end();return;}
      if(req.url==='/'&&req.method==='GET'){
        if(req.headers['sec-fetch-site']==='cross-site'){res.writeHead(403);res.end();return;}
        res.setHeader('Set-Cookie',expectedCookie+'; HttpOnly; SameSite=Strict; Path=/'+(ownerOrigin?.startsWith('https:')?'; Secure':''));
        res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page(csrf,grant,captureEvidence));return;
      }
      if(!authorized(req)){res.writeHead(403);res.end();return;}
      if(req.method==='GET'&&req.url==='/viewer/matrix-qualification-bridge.mjs'){res.setHeader('Content-Type','text/javascript');res.end(viewerBridge);return;}
      if(req.method==='POST'&&req.url?.startsWith('/__qual/')){
        if(!validOrigin(req)||!same(req.headers['x-qualification-csrf'],csrf)){res.writeHead(403);res.end('{}');return;}
        let size=0;const chunks=[];
        try{
          for await(const bytes of req){size+=bytes.length;if(size>1024)throw fail();chunks.push(bytes);}
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(!body||typeof body!=='object'||Array.isArray(body))throw fail();
          const action=req.url.slice(8);
          if(action==='presence'){if(Object.keys(body).length!==1||typeof body.visible!=='boolean')throw fail();controller.heartbeat(body.visible);}
          else{if(Object.keys(body).length)throw fail();if(action==='enable')await controller.enable();else if(action==='takeover')await controller.takeOver();else if(action==='stop')await controller.stop();else throw fail();}
          res.setHeader('Content-Type','application/json');res.end(JSON.stringify(controller.status()));
        }catch(error){report(error);if(!res.headersSent)res.writeHead(409);res.end('{"phase":"unavailable"}');}
        return;
      }
      if(req.method!=='GET'||!req.url?.startsWith('/viewer/')){res.writeHead(404);res.end();return;}
      try{
        const asset=await loadViewerAsset('/usr/share/kasmvnc/www',req.url);
        res.setHeader('Content-Type',asset.contentType);
        if(new URL(req.url,'http://qualification').pathname==='/viewer/'){
          const html=asset.data.toString('utf8');if(!/<\/body>/i.test(html))throw fail();
          res.end(html.replace(/<\/body>/i,'<script type="module" src="./matrix-qualification-bridge.mjs"></script></body>'));
        }else res.end(asset.data);
      }catch(error){report(error);res.writeHead(403);res.end();}
    });
    trackConnections(viewer);
    viewer.on('upgrade',(req,socket,head)=>{
      if(!authorized(req)||!validOrigin(req)||req.url!=='/viewer/websockify'||wsConnections.size){socket.destroy();return;}
      wsConnections.add(socket);
      const upstream=http.request({socketPath:join(statePath,'desktop/relay/viewer.sock'),path:'/websockify',headers:{host:'localhost:6901',origin:'http://localhost:6901',authorization:basic,connection:'Upgrade',upgrade:'websocket','sec-websocket-key':req.headers['sec-websocket-key'],'sec-websocket-version':'13','sec-websocket-protocol':req.headers['sec-websocket-protocol']??'binary'},timeout:8000});
      upstream.on('upgrade',(reply,remote,remoteHead)=>{
        if(reply.statusCode!==101){remote.destroy();socket.destroy();return;}
        socket.setTimeout(0);remote.setTimeout(0);
        const headers=['HTTP/1.1 101 Switching Protocols'];for(let i=0;i<reply.rawHeaders.length;i+=2)headers.push(reply.rawHeaders[i]+': '+reply.rawHeaders[i+1]);
        socket.write(headers.join('\r\n')+'\r\n\r\n');if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);
        try{controller.viewerConnected();}catch(error){report(error);socket.destroy();remote.destroy();return;}
        boundedPipe(socket,remote,32*1024*1024);boundedPipe(remote,socket,256*1024*1024);
        remote.once('close',()=>socket.destroy());socket.once('close',()=>remote.destroy());
      });
      upstream.on('response',()=>socket.destroy());upstream.on('error',()=>socket.destroy());upstream.on('timeout',()=>upstream.destroy());
      socket.once('close',()=>{wsConnections.delete(socket);upstream.destroy();void controller.viewerDisconnected().catch(report);});upstream.end();
    });
    await new Promise((done,reject)=>{viewer.once('error',reject);viewer.listen(0,'127.0.0.1',done);});port=viewer.address().port;
    mcp=net.createServer(socket=>{
      if(client){socket.destroy();return;}client=socket;socket.on('error',()=>{void stop().catch(report);});socket.once('close',()=>{void stop().catch(report);});
      server=createQualificationMcpServer({execute:async(action,signal)=>{
        const startedAt=Date.now();
        const result=await controller.execute(action,signal);
        if(captureEvidence&&result?.data&&evidenceCount<24){
          evidenceCount++;await writeFile(join(statePath,'host/evidence',`frame-${String(evidenceCount).padStart(2,'0')}.png`),Buffer.from(result.data,'base64'),{flag:'wx',mode:0o600});
        }
        if(controller.status().phase!=='active'||!controller.status().ownerPresent)throw fail();
        if(metadataCount++<512)console.log(JSON.stringify({event:'qualification_action',action:action.action,actionId:action.actionId,observationId:result.observationId,leaseEpoch:result.leaseEpoch,startedAt,completedAt:Date.now()}));
        return result;
      }});
      void server.connect(stopOnTransportLoss(createQualificationStdioTransport(socket,socket),stop,report)).catch(error=>{report(error);void stop().catch(report);});
    });
    await new Promise((done,reject)=>{mcp.once('error',reject);mcp.listen(join(statePath,'host/mcp.sock'),done);});await chmod(join(statePath,'host/mcp.sock'),0o600);
    timer=setInterval(()=>{void controller.tick().catch(report);},100);
    expiry=setTimeout(()=>{void stop().catch(report);},Math.min(600000,grant.expiresAt-Date.now()));
    await writeFile(join(statePath,'host/ready.json'),JSON.stringify({port,pid:process.pid,receipt,expiresAt:grant.expiresAt,evidence:captureEvidence?{maxImages:24,deleteAfter:Date.now()+7*86400000}:false})+'\n',{flag:'wx',mode:0o600});
    if(signal?.aborted)throw fail();return {port,stop};
  }catch(error){await stop();throw error;}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);let bundlePath,statePath,captureEvidence=false;
  for(let i=0;i<args.length;i++){if(args[i]==='--bundle')bundlePath=args[++i];else if(args[i]==='--state')statePath=args[++i];else if(args[i]==='--capture-evidence')captureEvidence=true;else throw fail();}
  const abort=new AbortController();
  const stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  await startGuardian({bundlePath,statePath,captureEvidence,signal:abort.signal}).then(async value=>{if(abort.signal.aborted)await value.stop();else console.log(JSON.stringify({ready:true,port:value.port,pid:process.pid}));}).catch(error=>{report(error);process.exitCode=1;});
}

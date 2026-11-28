import { mkdtemp, rm, mkdir, writeFile, chmod, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createOwnerController, createAllowedProxy, isPublicAddress, verifyManifest, loadViewerAsset, sandboxReadiness, reportGuardianFailure } from '../../scripts/spikes/computer-use/isolation/guardian.mjs';
import { connectTrustedSocket } from '../../scripts/spikes/computer-use/isolation/socket-client.mjs';

const cleanup: Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function fixture(){
  let now=1000;
  const session={execute:vi.fn(async()=>({ok:true})),presence:vi.fn(),stop:vi.fn(async()=>{}),setHumanControl:vi.fn(async()=>{})};
  const onStop=vi.fn(async()=>{});
  const control=createOwnerController({createSession:async()=>session,now:()=>now,onStop});
  return {session,control,onStop,advance:(ms:number)=>{now+=ms;}};
}
it('denies pixels/input until explicit enable plus actual viewer and visible owner heartbeat',async()=>{
  const {session,control}=fixture();
  await expect(control.execute({action:'observe'})).rejects.toThrow('qualification_unavailable');
  await expect(control.enable()).rejects.toThrow('owner_not_present');
  control.viewerConnected(); control.heartbeat(false);
  await expect(control.enable()).rejects.toThrow('owner_not_present');
  control.heartbeat(true);await control.enable();
  expect(session.setHumanControl).toHaveBeenCalledWith(false);
  await control.execute({action:'observe'});expect(session.execute).toHaveBeenCalledOnce();
  await control.stop();
});
it('viewer loss revokes immediately and waits for drain before acknowledging stop',async()=>{
  const {session,control,onStop}=fixture();let release!:()=>void;
  session.stop.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  control.viewerConnected();control.heartbeat(true);await control.enable();
  const stopping=control.viewerDisconnected();
  await expect(control.execute({action:'observe'})).rejects.toThrow('qualification_unavailable');
  expect(onStop).not.toHaveBeenCalled();release();await stopping;expect(onStop).toHaveBeenCalledOnce();
});
it('silent absence stops after 5s; model execution never renews owner presence',async()=>{
  const {session,control,advance}=fixture();control.viewerConnected();control.heartbeat(true);await control.enable();
  advance(5001);await control.tick();expect(session.stop).toHaveBeenCalledOnce();
  await expect(control.enable()).rejects.toThrow('qualification_unavailable');
});
it('takeover opens human input only after drain and cannot resume the old grant',async()=>{
  const {session,control}=fixture();let release!:()=>void;
  session.stop.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  control.viewerConnected();control.heartbeat(true);await control.enable();const handover=control.takeOver();
  expect(session.setHumanControl).toHaveBeenCalledTimes(1);release();await handover;
  expect(session.setHumanControl).toHaveBeenLastCalledWith(true);
  await expect(control.enable()).rejects.toThrow('qualification_unavailable');await control.stop();
});
it('failed release never acknowledges human control',async()=>{
  const {session,control,onStop}=fixture();control.viewerConnected();control.heartbeat(true);await control.enable();
  session.stop.mockRejectedValue(new Error('cleanup_failed'));
  await expect(control.takeOver()).rejects.toThrow('cleanup_failed');
  expect(session.setHumanControl).toHaveBeenCalledTimes(1);expect(onStop).toHaveBeenCalledOnce();
});
it('stop during asynchronous enable never grants control after the factory returns',async()=>{
  const session={stop:vi.fn(async()=>{}),presence:vi.fn(),setHumanControl:vi.fn(async()=>{})};
  let finish!:(value:typeof session)=>void;
  const onStop=vi.fn(async()=>{});
  const control=createOwnerController({createSession:()=>new Promise(resolve=>{finish=resolve;}),onStop});
  control.viewerConnected();control.heartbeat(true);const enabled=control.enable().catch((error:Error)=>error.message);
  const stopped=control.stop();finish(session);await stopped;
  expect(await enabled).toBe('qualification_unavailable');expect(session.setHumanControl).not.toHaveBeenCalled();expect(onStop).toHaveBeenCalledOnce();
});
it('denied VNC input gate revokes without allowing a screenshot',async()=>{
  const {session,control,onStop}=fixture();control.viewerConnected();control.heartbeat(true);
  session.setHumanControl.mockRejectedValue(new Error('permission_denied'));
  await expect(control.enable()).rejects.toThrow('permission_denied');
  await expect(control.execute({action:'observe'})).rejects.toThrow('qualification_unavailable');
  expect(session.execute).not.toHaveBeenCalled();expect(onStop).toHaveBeenCalledOnce();
});
it('rejects private, mapped, multicast and reserved DNS answers',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.0.2.1','100.64.0.1','224.0.0.1','::1','::ffff:8.8.8.8','fc00::1','2001:db8::1'])expect(isPublicAddress(ip),ip).toBe(false);
  expect(isPublicAddress('93.184.216.34')).toBe(true);expect(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
});
async function proxyFixture(answers=[{address:'93.184.216.34',family:4}]){
  const dir=await mkdtemp(join(tmpdir(),'matrix-guardian-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const seen:string[]=[];
  const upstream=http.createServer((req,res)=>{seen.push(req.url!);res.end('synthetic proxy fixture');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  cleanup.push(()=>new Promise<void>(r=>upstream.close(()=>r())));
  const dial=vi.fn((target:net.TcpNetConnectOpts)=>{expect(target.port).toBeGreaterThan(0);return net.connect((upstream.address() as net.AddressInfo).port,'127.0.0.1');});
  const proxy=createAllowedProxy({lookup:async()=>answers,dial});await proxy.listen(join(dir,'proxy.sock'));cleanup.push(()=>proxy.close());
  const request=(path:string,method='GET')=>new Promise<{status:number,body:string}>((resolve,reject)=>{
    const req=http.request({socketPath:join(dir,'proxy.sock'),path,method},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode!,body}));});req.on('error',reject);req.end();
  });
  const connect=(target:string)=>new Promise<string>((resolve,reject)=>{
    const socket=net.connect(join(dir,'proxy.sock'));socket.on('error',reject);
    socket.on('connect',()=>socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once('data',bytes=>{resolve(bytes.toString());socket.destroy();});
  });return {request,connect,dial,seen};
}
it('real Unix HTTP boundary denies unapproved destinations/methods and pins approved DNS',async()=>{
  const {request,dial,seen}=await proxyFixture();
  for(const [path,method] of [['http://localhost/','GET'],['http://example.com/','POST'],['http://user:password@example.com/','GET'],['http://example.com:123/','GET'],['http://example.com.evil/','GET']])expect((await request(path,method)).status).toBe(403);
  expect(dial).not.toHaveBeenCalled();expect((await request('http://example.com/')).body).toBe('synthetic proxy fixture');
  expect(dial.mock.calls[0][0]).toMatchObject({host:'93.184.216.34',port:80});expect(seen).toEqual(['/']);
});
it('fails closed if any DNS answer is private',async()=>{
  const {request,dial}=await proxyFixture([{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]);
  expect((await request('http://example.com/')).status).toBe(403);expect(dial).not.toHaveBeenCalled();
});
it('real CONNECT boundary admits only exact example.com:443 with a pinned public address',async()=>{
  const {connect,dial}=await proxyFixture();
  expect(await connect('127.0.0.1:443')).toContain('403');expect(await connect('example.com:80')).toContain('403');expect(dial).not.toHaveBeenCalled();
  expect(await connect('example.com:443')).toContain('200 Connection Established');expect(dial.mock.calls[0][0]).toMatchObject({host:'93.184.216.34',port:443});
});
it('validates actual bundle bytes and refuses undeclared files and linked roots',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'matrix-guardian-manifest-')));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'code'));await mkdir(join(dir,'deps'));
  const content='synthetic fixture';await writeFile(join(dir,'code/example.mjs'),content);
  await writeFile(join(dir,'manifest.json'),JSON.stringify({version:1,files:[{path:'code/example.mjs',sha256:createHash('sha256').update(content).digest('hex'),size:Buffer.byteLength(content)}]}),{mode:0o600});
  await expect(verifyManifest(dir)).resolves.toMatchObject({version:1});
  await writeFile(join(dir,'deps/unreviewed'),'x');await expect(verifyManifest(dir)).rejects.toThrow('qualification_unavailable');
  await rm(join(dir,'deps'),{recursive:true});await symlink(join(dir,'code'),join(dir,'deps'));await expect(verifyManifest(dir)).rejects.toThrow('qualification_unavailable');
});
it('bounds actual stdio Unix bridge frames and closes on transport loss',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'matrix-guardian-bridge-')));cleanup.push(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'host'),{mode:0o700});
  let peer:net.Socket|undefined;const chunks:Buffer[]=[];
  const server=net.createServer(socket=>{peer=socket;socket.on('error',()=>socket.destroy());socket.on('data',bytes=>chunks.push(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes)));});
  await new Promise<void>(r=>server.listen(join(dir,'host/mcp.sock'),r));await chmod(join(dir,'host/mcp.sock'),0o600);
  cleanup.push(async()=>{peer?.destroy();await new Promise<void>(r=>server.close(()=>r()));});
  const input=new PassThrough(),output=new PassThrough(),received:Buffer[]=[];output.on('data',bytes=>received.push(bytes));
  const bridge=await connectTrustedSocket({statePath:dir,input,output});cleanup.push(async()=>bridge.close());
  input.write('{"synthetic":"request"}\n');await vi.waitFor(()=>expect(chunks.length).toBeGreaterThan(0));
  peer!.write('{"synthetic":"response"}\n');await vi.waitFor(()=>expect(Buffer.concat(received).toString()).toContain('response'));
  const closed=new Promise<void>(r=>peer!.once('close',()=>r()));input.write(Buffer.alloc(32769,65));await closed;
  expect(Buffer.concat(chunks).length).toBeLessThan(32769);await delay(1);
});

it('loads owner-origin viewer code only from trusted host assets even if desktop rebinds its socket',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'matrix-viewer-assets-')));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const root=join(dir,'trusted');await mkdir(root);await writeFile(join(root,'index.html'),'<body>trusted viewer</body>');
  const socketPath=join(dir,'desktop-viewer.sock');
  const maliciousRequests=vi.fn();const malicious=http.createServer((_req,res)=>{maliciousRequests();res.setHeader('Content-Type','text/html');res.end('<body><script>parent.stealOwnerAuthority()</script></body>');});
  await new Promise<void>(done=>malicious.listen(socketPath,done));cleanup.push(()=>new Promise<void>(done=>malicious.close(()=>done())));
  const asset=await loadViewerAsset(root,'/viewer/');
  expect(asset.data.toString()).toBe('<body>trusted viewer</body>');expect(maliciousRequests).not.toHaveBeenCalled();
  await expect(loadViewerAsset(root,'/viewer/%2e%2e/outside')).rejects.toThrow('qualification_unavailable');
  await symlink(join(dir,'outside'),join(root,'linked.js'));await writeFile(join(dir,'outside'),'private host data');
  await expect(loadViewerAsset(root,'/viewer/linked.js')).rejects.toThrow('qualification_unavailable');
});

it('reports only finite startup phases while discarding arbitrary failure content',()=>{
  for(const phase of ['xvnc','desktop_apps','viewer_credentials']){
    try{sandboxReadiness({ready:false,phase,error:'secret stderr'});throw new Error('accepted failure');}
    catch(error){expect(error).toMatchObject({message:'qualification_unavailable',phase});expect(JSON.stringify(error)).not.toContain('secret');}
  }
  try{sandboxReadiness({ready:false,phase:'/private/secret token',error:'password'});throw new Error('accepted failure');}
  catch(error){expect(error).not.toHaveProperty('phase');expect(JSON.stringify(error)).not.toContain('secret');}
});

it('preserves only finite classified Xvnc startup diagnostics with bounded counters',()=>{
  const codes=['unsupported_option','missing_shared_library','sandbox_unavailable','socket_binding','display_lock','font_unavailable','xkb_unavailable','permission_denied','missing_runtime_file','viewer_authentication','unclassified'];
  for(const code of codes){
    const diagnostic={service:'xvnc',code,exit_code:1,stderr_bytes:65536,truncated:true};
    try{sandboxReadiness({ready:false,phase:'xvnc',diagnostic:{...diagnostic,stderr:'secret program output',path:'/private/secret',password:'secret'}});throw new Error('accepted failure');}
    catch(error){expect(error).toMatchObject({message:'qualification_unavailable',phase:'xvnc',diagnostic});expect((error as {diagnostic?:unknown}).diagnostic).toEqual(diagnostic);expect(JSON.stringify(error)).not.toContain('secret');}
  }
});

it('drops invented startup codes and invalid numeric/boolean diagnostic fields',()=>{
  for(const diagnostic of [{service:'other',code:'unclassified'},{service:'xvnc',code:'/private/secret'},{service:'xvnc',code:'unknown'}]){
    try{sandboxReadiness({ready:false,phase:'xvnc',diagnostic});throw new Error('accepted failure');}
    catch(error){expect(error).not.toHaveProperty('diagnostic');}
  }
  for(const invalid of [-256,256,1.5,NaN,Infinity,'1',true]){
    try{sandboxReadiness({ready:false,phase:'xvnc',diagnostic:{service:'xvnc',code:'unclassified',exit_code:invalid,stderr_bytes:65537,truncated:'true',stderr:'secret'}});throw new Error('accepted failure');}
    catch(error){expect((error as {diagnostic?:unknown}).diagnostic).toEqual({service:'xvnc',code:'unclassified'});}
  }
});

it('logs classified startup metadata without raw output, paths, passwords or invented fields',()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    const diagnostic={service:'xvnc',code:'unsupported_option',exit_code:-15,stderr_bytes:8192,truncated:false};
    try{sandboxReadiness({ready:false,phase:'xvnc',diagnostic:{...diagnostic,stderr:'secret',password:'secret',path:'/private/secret'}});}
    catch(error){reportGuardianFailure(error);}
    expect(warn).toHaveBeenLastCalledWith('[computer-qualification] guardian_failed','Error','xvnc',diagnostic);
    reportGuardianFailure(Object.assign(new Error('secret message'),{name:'secret name',phase:'secret phase',diagnostic:{service:'xvnc',code:'secret',stderr:'secret'}}));
    expect(warn).toHaveBeenLastCalledWith('[computer-qualification] guardian_failed','UnknownError','','');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  }finally{warn.mockRestore();}
});

it('preserves classified pre-spawn errno without forwarding invalid values or exception text',()=>{
  for(const code of ['resource_limit','invalid_executable']){
    for(const errno of [1,4095]){
      try{sandboxReadiness({ready:false,phase:'xvnc',diagnostic:{service:'xvnc',code,errno,exception:'private executable path'}});throw new Error('accepted failure');}
      catch(error){expect((error as {diagnostic?:unknown}).diagnostic).toEqual({service:'xvnc',code,errno});}
    }
  }
  for(const errno of [0,4096,-1,1.5,NaN,Infinity,'2',true]){
    try{sandboxReadiness({ready:false,phase:'xvnc',diagnostic:{service:'xvnc',code:'unclassified',errno}});throw new Error('accepted failure');}
    catch(error){expect((error as {diagnostic?:unknown}).diagnostic).toEqual({service:'xvnc',code:'unclassified'});}
  }
});

it('preserves only fixed desktop service IDs and the captured original exit code',()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    for(const service of ['xvnc','openbox','panel','chrome']){
      const diagnostic={service,code:'unclassified',exit_code:11,stderr_bytes:1,truncated:false};
      try{sandboxReadiness({ready:false,phase:'desktop_apps',diagnostic});throw new Error('accepted failure');}
      catch(error){
        diagnostic.exit_code=1;
        const expected={service,code:'unclassified',exit_code:11,stderr_bytes:1,truncated:false};
        expect((error as {diagnostic?:unknown}).diagnostic).toEqual(expected);
        reportGuardianFailure(error);expect(warn).toHaveBeenLastCalledWith('[computer-qualification] guardian_failed','Error','desktop_apps',expected);
      }
    }
    for(const service of ['tint2','Chrome','/private/secret','chrome --argument','',null]){
      try{sandboxReadiness({ready:false,phase:'desktop_apps',diagnostic:{service,code:'unclassified',exit_code:11}});throw new Error('accepted failure');}
      catch(error){expect(error).not.toHaveProperty('diagnostic');}
    }
  }finally{warn.mockRestore();}
});

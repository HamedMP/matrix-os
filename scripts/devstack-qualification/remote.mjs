// Only synthetic sources are projected. This server is not a Matrix gateway.
export const service = String.raw`import { createServer } from 'node:http';
import { writeFileSync, renameSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { revision } from './revision.mjs';
const workspace = process.env.QUALIFICATION_WORKSPACE;
const token = Buffer.from(process.env.QUALIFICATION_TOKEN);
const emit = detail => console.log('[devstack-fixture] '+JSON.stringify({workspace,revision,pid:process.pid,...detail}));
const server = createServer((request,response) => {
  const presented = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.concat([Buffer.from('Bearer '),token]);
  if (presented.length!==expected.length || !timingSafeEqual(presented,expected)) {
    response.writeHead(401,{'content-type':'application/json'});response.end('{}');return;
  }
  const requestId = String(request.headers['x-request-id']??'').slice(0,80);
  emit({event:'request',requestId});
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify({workspace,revision,pid:process.pid,requestId}));
});
server.listen(0,'127.0.0.1',()=>{
  const state={workspace,revision,pid:process.pid,port:server.address().port};
  writeFileSync(process.env.QUALIFICATION_READY+'.tmp',JSON.stringify(state),{mode:0o600});renameSync(process.env.QUALIFICATION_READY+'.tmp',process.env.QUALIFICATION_READY);emit({event:'ready',port:state.port});
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
`;

async function remoteMain() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { spawn, spawnSync } = await import('node:child_process');
  const input = JSON.parse(process.argv[1]);
  const { root, runId, op } = input;
  const uid = process.getuid();
  if (!uid || Number(process.versions.node.split('.')[0]) < 24) throw new Error('A non-root Node 24+ target is required');
  if (!/^[a-f0-9]{32}$/.test(runId) || !path.isAbsolute(root) || path.basename(root)!=='qualification-'+runId) throw new Error('Invalid run identity');
  const json = file => {
    const info=fs.lstatSync(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>16000||info.uid!==uid)throw new Error('Unsafe fixture metadata');
    return JSON.parse(fs.readFileSync(file,'utf8'));
  };
  const write = (file,value) => fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
  const workspacePath = id => {
    if(!/^w-[0-7]-[a-f0-9]{8}$/.test(id))throw new Error('Invalid workspace identity');
    return path.join(root,id);
  };
  const marker=path.join(root,'.owner.json');
  if(op==='initialize') {
    const tool=fs.statSync(input.tsx);
    if(!tool.isFile())throw new Error('Target tsx tool missing');
    const base=path.dirname(root);
    const toolCheckout=input.tsx.split('/node_modules/tsx/')[0];
    if(base===toolCheckout||base.startsWith(toolCheckout+'/'))throw new Error('Fixture target must be outside the shared tool checkout');
    // Reject noncanonical existing ancestors before recursive mkdir can write
    // a missing child through one of their symlinks.
    let ancestor=base;
    for(;;){
      try{fs.lstatSync(ancestor);break;}
      catch(error){
        if(error.code!=='ENOENT')throw error;
        const parent=path.dirname(ancestor);
        if(parent===ancestor)throw error;
        ancestor=parent;
      }
    }
    if(fs.realpathSync(ancestor)!==ancestor)throw new Error('Target base must be canonical');
    fs.mkdirSync(base,{recursive:true,mode:0o700});
    if(fs.realpathSync(base)!==base)throw new Error('Target base must be canonical');
    fs.mkdirSync(root,{mode:0o700});
    try{fs.writeFileSync(marker,JSON.stringify({runId,uid}),{flag:'wx',mode:0o600});}
    catch(error){fs.rmSync(root,{recursive:true,force:true});throw error;}
    return {initialized:true,uid,node:process.versions.node};
  }
  const info=fs.lstatSync(root);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==uid||(info.mode&0o777)!==0o700||fs.realpathSync(root)!==root)throw new Error('Unsafe fixture root');
  const owner=json(marker);
  if(owner.runId!==runId||owner.uid!==uid)throw new Error('Fixture marker mismatch');
  const pidInfo = pid => {
    if(!Number.isSafeInteger(pid)||pid<1)throw new Error('Invalid fixture PID');
    try {
      const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      const descriptor=fs.openSync('/proc/'+pid+'/cmdline','r');
      const buffer=Buffer.alloc(4096);let bytes;
      try{bytes=fs.readSync(descriptor,buffer,0,buffer.length,0);}finally{fs.closeSync(descriptor);}
      const args=buffer.subarray(0,bytes).toString('utf8').split(String.fromCharCode(0)).filter(Boolean);
      return {pid,start:fields[19],group:Number(fields[2]),uid:fs.lstatSync('/proc/'+pid).uid,args,command:args.join(' '),state:fields[0]};
    } catch(error) {if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}
  };
  const alive = pid => {const current=pidInfo(pid);return current&&current.state!=='Z';};
  const groupAlive = group => {
    let count=0;
    for(const name of fs.readdirSync('/proc')){
      if(++count>10000)throw new Error('Process group inventory exceeds bound');
      if(!/^\d+$/.test(name))continue;
      const item=pidInfo(Number(name));
      if(item&&item.uid===uid&&item.group===group&&item.state!=='Z')return true;
    }
    return false;
  };
  const checked = (record,needle) => {
    if(!Number.isSafeInteger(record?.pid)||record.pid<2)throw new Error('Invalid owned PID');
    const current=pidInfo(record.pid);
    if(!current||current.start!==record.start||current.uid!==uid||!current.command.includes(needle))throw new Error('Process ownership mismatch');
    return current;
  };
  const checkedAgent = (record,id) => {
    const current=checked(record,'mutagen-agent synchronizer');
    if(path.basename(current.args[0]??'')!=='mutagen-agent'||current.args[1]!=='synchronizer')throw new Error('Invalid transport executable');
    const expected=fs.lstatSync(path.join(workspacePath(id),'source'),{bigint:true});
    let count=0,matched=false;
    for(const name of fs.readdirSync('/proc/'+record.pid+'/fdinfo')){
      if(++count>128)throw new Error('Transport descriptor inventory exceeds bound');
      const fd=fs.openSync('/proc/'+record.pid+'/fdinfo/'+name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const buffer=Buffer.alloc(16000);let size;
      try{size=fs.readSync(fd,buffer,0,buffer.length,0);}finally{fs.closeSync(fd);}
      for(const line of buffer.subarray(0,size).toString('utf8').split('\n')){
        if(!line.startsWith('inotify '))continue;
        const fields=Object.fromEntries(line.trim().split(/\s+/).slice(1).map(item=>item.split(':')));
        // The initial recursive watch must belong to this exact fixture root,
        // not merely a broad ancestor or a newly reconnected unrelated agent.
        if(fields.wd==='1'&&fields.ino&&fields.sdev&&BigInt('0x'+fields.ino)===expected.ino&&BigInt('0x'+fields.sdev)===expected.dev)matched=true;
      }
    }
    if(!matched)throw new Error('Transport agent root ownership mismatch');
    return current;
  };
  const stateFile = id => path.join(workspacePath(id),'.runtime.json');
  const state = id => {const value=json(stateFile(id));if(value.workspace!==id)throw new Error('Workspace metadata mismatch');return value;};
  const stopValue = async (id,value) => {
    if(!alive(value.watcher.pid)){if(groupAlive(value.watcher.pid))throw new Error('Uncertain process group ownership');return {alreadyStopped:true,groupGone:true};}
    checked(value.watcher,path.join(workspacePath(id),'source/service.mjs'));
    process.kill(-value.watcher.pid,'SIGTERM');
    const until=Date.now()+6000;
    while(Date.now()<until&&groupAlive(value.watcher.pid))await new Promise(resolve=>setTimeout(resolve,50));
    if(groupAlive(value.watcher.pid))process.kill(-value.watcher.pid,'SIGKILL');
    const ended=Date.now()+2000;
    while(Date.now()<ended&&groupAlive(value.watcher.pid))await new Promise(resolve=>setTimeout(resolve,50));
    if(groupAlive(value.watcher.pid))throw new Error('Fixture process group did not stop');
    return {stopped:true,groupGone:true};
  };
  if(op==='prepare') {
    const directory=workspacePath(input.workspace);
    fs.mkdirSync(directory,{mode:0o700});
    const source=path.join(directory,'source');fs.mkdirSync(source,{mode:0o700});
    for(const name of ['node_modules','dist','.local']){
      fs.mkdirSync(path.join(source,name),{mode:0o700});
      fs.writeFileSync(path.join(source,name,'keep.txt'),'generated-'+name,{mode:0o600});
    }
    return {source};
  }
  const start = async id => {
    const directory=workspacePath(id);
    const token=crypto.randomBytes(24).toString('hex');
    const descriptor=fs.openSync(path.join(directory,'watch.log'),'a',0o600);
    let child,value;
    try {
      child=spawn(process.execPath,[input.tsx,'watch','--clear-screen=false',path.join(directory,'source/service.mjs')],{
        cwd:path.join(directory,'source'),detached:true,stdio:['ignore',descriptor,descriptor],
        env:{...process.env,QUALIFICATION_WORKSPACE:id,QUALIFICATION_TOKEN:token,QUALIFICATION_READY:path.join(directory,'ready.json')},
      });
      await new Promise((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});
      if(!child.pid)throw new Error('Fixture watcher did not start');
      value={workspace:id,token,watcher:pidInfo(child.pid)};
      write(stateFile(id),value);
      return {watcher:value.watcher};
    }catch(error){
      if(value?.watcher){const stopped=await stopValue(id,value);error.ownedGroupStopped=stopped.groupGone;}
      throw error;
    }finally{fs.closeSync(descriptor);child?.unref();}
  };
  if(op==='start')return await start(input.workspace);
  if(op==='negative-start'){
    const file=stateFile(input.workspace);
    fs.writeFileSync(file,'{}',{flag:'wx',mode:0o400});
    try{
      await start(input.workspace);throw new Error('Unwritable metadata accepted');
    }catch(error){
      if(error.code!=='EACCES'||!error.ownedGroupStopped)throw error;
      return {rejected:true,ownedGroupStopped:true};
    }finally{fs.unlinkSync(file);fs.rmSync(path.join(workspacePath(input.workspace),'ready.json'),{force:true});}
  }
  if(op==='http') {
    const values=[];
    for(const id of input.workspaces){
      const directory=workspacePath(id),readyPath=path.join(directory,'ready.json');
      if(!fs.existsSync(readyPath)){values.push({workspace:id,status:null});continue;}
      const ready=json(readyPath),value=state(id);
      if(ready.workspace!==id||!Number.isInteger(ready.port)||ready.port<1||ready.port>65535)throw new Error('Invalid fixture readiness');
      const token=input.tokenWorkspace?state(input.tokenWorkspace).token:value.token;
      try {
        const response=await fetch('http://127.0.0.1:'+ready.port+'/',{headers:{...(input.unauthenticated?{}:{Authorization:'Bearer '+token}),'x-request-id':input.requestId},signal:AbortSignal.timeout(700),redirect:'error'});
        const body=await response.json();values.push({workspace:id,status:response.status,body});
      }catch(error){values.push({workspace:id,status:null,error:error.name});}
    }
    return values;
  }
  if(op==='audit') {
    const source=path.join(workspacePath(input.workspace),'source');
    const sentinels=Object.fromEntries(['node_modules','dist','.local'].map(name=>[name,fs.readFileSync(path.join(source,name,'keep.txt'),'utf8')]));
    return {sentinels,secretAbsent:!fs.existsSync(path.join(source,'.env.sentinel')),gitAbsent:!fs.existsSync(path.join(source,'.git')),
      sourceHash:crypto.createHash('sha256').update(fs.readFileSync(path.join(source,'revision.mjs'))).digest('hex')};
  }
  if(op==='logs') {
    const value=state(input.workspace),file=path.join(workspacePath(input.workspace),'watch.log');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {
      const size=fs.fstatSync(fd).size,start=Math.max(0,size-64000),buffer=Buffer.alloc(size-start);
      fs.readSync(fd,buffer,0,buffer.length,start);
      return {workspace:input.workspace,start,cursor:size,text:buffer.toString('utf8').replaceAll(value.token,'[redacted]')};
    }finally{fs.closeSync(fd);}
  }
  if(op==='failed-command') {
    const value=state(input.workspace);
    const result=spawnSync(process.execPath,['-e','console.log(JSON.stringify({event:"fixture-test-failed",workspace:process.argv[1],revision:process.argv[2],token:process.argv[3]}));process.exitCode=1',input.workspace,input.revision,value.token],{encoding:'utf8',timeout:5000,maxBuffer:64000});
    if(result.error)throw result.error;
    const raw=result.stdout+result.stderr;
    return {workspace:input.workspace,exit:result.status,text:raw.replaceAll(value.token,'[redacted]'),redacted:raw.includes(value.token)};
  }
  if(op==='agents') {
    const values=[];let count=0;
    for(const entry of fs.readdirSync('/proc')){
      if(++count>10000)throw new Error('Process inventory exceeds bound');
      if(!/^\d+$/.test(entry))continue;
      const current=pidInfo(Number(entry));
      if(current&&current.uid===uid&&path.basename(current.args[0]??'')==='mutagen-agent'&&current.args[1]==='synchronizer')values.push(current);
    }
    return values;
  }
  if(op==='remember-agent') {
    checkedAgent(input.agent,input.workspace);
    write(path.join(workspacePath(input.workspace),'.agent.json'),input.agent);
    return {remembered:true};
  }
  if(op==='signal-agent') {
    if(!['SIGSTOP','SIGCONT','SIGKILL'].includes(input.signal))throw new Error('Invalid agent signal');
    const record=json(path.join(workspacePath(input.workspace),'.agent.json'));
    const current=checkedAgent(record,input.workspace);
    process.kill(current.pid,input.signal);return {pid:current.pid,signal:input.signal};
  }
  if(op==='negative-agent') {
    const other=json(path.join(workspacePath(input.other),'.agent.json'));
    try{checkedAgent(other,input.workspace);throw new Error('Foreign endpoint accepted');}
    catch(error){if(error.message!=='Transport agent root ownership mismatch')throw error;}
    return {rejected:true,otherAlive:!!alive(other.pid)};
  }
  if(op==='negative-pid') {
    const original=state(input.workspace),other=state(input.other);
    const rejected=[];
    try {
      for(const candidate of [other.watcher,{...original.watcher,start:'0'}]){
        write(stateFile(input.workspace),{...original,watcher:candidate});
        try {await stopValue(input.workspace,state(input.workspace));throw new Error('Unsafe PID accepted');}
        catch(error){if(error.message!=='Process ownership mismatch')throw error;rejected.push(true);}
      }
    }finally{write(stateFile(input.workspace),original);}
    return {rejected:rejected.length,otherAlive:!!alive(other.watcher.pid)};
  }
  if(op==='stop')return await stopValue(input.workspace,state(input.workspace));
  if(op==='remove-workspace'){const file=stateFile(input.workspace);if(fs.existsSync(file)&&groupAlive(state(input.workspace).watcher.pid))throw new Error('Active group prevents workspace removal');fs.rmSync(workspacePath(input.workspace),{recursive:true,force:true});return {removed:true};}
  if(op==='verify-gone')return {gone:input.records.every(record=>{const current=pidInfo(record.pid);return !current||current.start!==record.start||current.state==='Z';})};
  if(op==='cleanup') {
    for(const id of input.workspaces){if(fs.existsSync(stateFile(id))&&groupAlive(state(id).watcher.pid))throw new Error('Active watcher prevents cleanup');}
    fs.rmSync(root,{recursive:true,force:true});return {removed:true};
  }
  throw new Error('Unknown qualification operation');
}

export const remoteProgram = `(${remoteMain.toString()})().then(value=>console.log(JSON.stringify({ok:true,value}))).catch(error=>console.log(JSON.stringify({ok:false,error:{code:error.code??'operation_failed',message:String(error.message).slice(0,2000)}})));`;

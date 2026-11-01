// Actual native-helper/Zellij bootstrap interoperability only; no keeper/source proof.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, lstat, readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const [addonPath,binaryPath,evidencePath,expectedBinarySha256]=process.argv.slice(2);
const result={scope:'actual anonymous native-helper to actual owned Zellij bootstrap only',sourceEnabled:false,accountQualified:false,keeperQualified:false,sessionInitializationQualified:false,protectedImageQualified:false,checks:[],cleanup:{}};
const native=createRequire(import.meta.url)(addonPath);
const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const check=(name,ok)=>{result.checks.push({name,ok:!!ok});assert.ok(ok,name);};
let pair,child,birth,work,exit;
const until=async(fn,label,ms=2500)=>{const limit=process.hrtime.bigint()+BigInt(ms)*1000000n;while(!await fn()){assert.ok(process.hrtime.bigint()<limit,label);await delay(2);}};
try {
  result.artifacts={addonSha256:await digest(addonPath),zellijSha256:await digest(binaryPath)};
  check('reviewed actual Zellij artifact digest',/^[a-f0-9]{64}$/.test(expectedBinarySha256??'')&&result.artifacts.zellijSha256===expectedBinarySha256);
  check('unprivileged Linux with non-PID1 actual parent',process.platform==='linux'&&process.getuid()!==0&&process.pid>1);
  work=await mkdtemp('/tmp/mx-owned-');pair=native.controlPair();
  child=spawn(binaryPath,['--matrix-private-server','3'],{cwd:work,env:{HOME:work,XDG_CONFIG_HOME:work+'/config',XDG_CACHE_HOME:work+'/cache',PATH:'/usr/bin:/bin',TERM:'xterm-256color'},stdio:['ignore','ignore','ignore',native.controlChildFd(pair.child)],shell:false});
  exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});exit.catch(()=>{});
  birth=native.retainChild(child.pid);native.close(pair.child);
  const generation=randomBytes(32),nonce=randomBytes(32),socket=Buffer.from(work+'/daemon.sock');
  const deadline=process.hrtime.bigint()+2000000000n;
  const body=Buffer.alloc(74+socket.length);body.writeBigUInt64LE(deadline);generation.copy(body,8);nonce.copy(body,40);body.writeUInt16LE(socket.length,72);socket.copy(body,74);
  const header=Buffer.alloc(16);header.write('MXZBOOT\0',0,'ascii');header[8]=1;header[9]=1;header.writeUInt32LE(body.length,12);
  const frame=Buffer.concat([header,body]);let offset=0;
  while(offset<frame.length){check('original producer budget current before bootstrap send',process.hrtime.bigint()<deadline);offset+=native.send(pair.channel,frame.subarray(offset));if(offset<frame.length)await delay(2);}
  let ack=Buffer.alloc(0);
  while(ack.length<80){assert.ok(process.hrtime.bigint()<deadline,'original bootstrap receive budget');const packet=native.receive(pair.channel);if(packet===null){await delay(2);continue;}assert.ok(packet,'no early control EOF');check('per-write credentials match actual returned live daemon',packet.writer.pid===child.pid&&packet.writer.uid===process.getuid()&&packet.writer.gid===process.getgid()&&native.childAlive(birth));ack=Buffer.concat([ack,packet.data]);assert.ok(ack.length<=80,'bounded single correlation ACK');}
  const expected=Buffer.alloc(80);expected.write('MXZBOOT\0',0,'ascii');expected[8]=1;expected[9]=2;expected.writeUInt32LE(64,12);generation.copy(expected,16);nonce.copy(expected,48);
  check('exact correlation ACK under original budget',ack.equals(expected)&&process.hrtime.bigint()<deadline);
  await until(async()=>{try{return(await lstat(work+'/daemon.sock')).isSocket();}catch(error){if(error.code==='ENOENT')return false;throw error;}},'bounded socket creation observation');
  check('actual returned daemon remains live after socket creation',native.childAlive(birth));
  native.close(pair.channel);await delay(150);
  check('private control EOF does not claim or cause native stop',native.childAlive(birth)&&child.exitCode===null&&child.signalCode===null);
  result.status='component-pass';
}catch(error){result.status='component-fail';result.error=String(error.stack??error);}
finally{
  if(pair){native.close(pair.child);native.close(pair.channel);}
  if(child){
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exit,delay(500)]);if(child.exitCode===null&&child.signalCode===null){result.cleanup.escalatedToSigkill=true;child.kill('SIGKILL');}}
    try{result.cleanup.actualChildClose=await Promise.race([exit,delay(2500).then(()=>{throw new Error('actual cleanup deadline');})]);}catch(error){result.cleanup.error=String(error);}
  }
  if(birth){result.cleanup.birthDead=!native.childAlive(birth);native.close(birth);}
  if(work){await rm(work,{recursive:true,force:true});result.cleanup.ownedTemporaryRemoved=true;}
}
const {writeFile}=await import('node:fs/promises');await writeFile(evidencePath,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
process.exitCode=result.status==='component-pass'&&result.cleanup.birthDead&&!result.cleanup.error?0:1;

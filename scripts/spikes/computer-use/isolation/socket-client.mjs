/** Trusted stdio→one owner Unix socket bridge. No endpoint comes from MCP arguments. */
import net from 'node:net';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';

function lineBound(maxBytes) {
  let pending=0;
  return new Transform({highWaterMark:64*1024,transform(bytes,_encoding,done){
    for(const byte of bytes){if(byte===10)pending=0;else if(++pending>maxBytes){done(new Error('transport_input_limit'));return;}}
    done(null,bytes);
  }});
}
/** @param {{statePath: string, input?: import('node:stream').Readable, output?: import('node:stream').Writable}} options */
export async function connectTrustedSocket({statePath,input=process.stdin,output=process.stdout}) {
  if(!isAbsolute(statePath)||await realpath(statePath)!==statePath)throw new Error('qualification_unavailable');
  for(const path of [statePath,join(statePath,'host')]){
    const stat=await lstat(path);if(!stat.isDirectory()||stat.uid!==process.getuid()||stat.mode&0o077)throw new Error('qualification_unavailable');
  }
  const path=join(statePath,'host/mcp.sock'),stat=await lstat(path);
  if(!stat.isSocket()||stat.uid!==process.getuid()||stat.mode&0o077||await realpath(path)!==path)throw new Error('qualification_unavailable');
  const socket=net.connect(path),toSocket=lineBound(32*1024),toOutput=lineBound(3*1024*1024);
  let closed=false;
  const close=()=>{
    if(closed)return;closed=true;input.unpipe(toSocket);input.pause();socket.unpipe(toOutput);toSocket.destroy();toOutput.destroy();socket.destroy();
  };
  try{
    await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error('transport_unavailable')),3000);socket.once('connect',()=>{clearTimeout(timer);done();});socket.once('error',error=>{clearTimeout(timer);reject(error);});});
  }catch(error){close();throw error;}
  for(const stream of [input,output,socket,toSocket,toOutput])stream.once('error',close);
  input.once('end',()=>socket.end());socket.once('close',close);output.once('close',close);
  input.pipe(toSocket).pipe(socket);socket.pipe(toOutput).pipe(output,{end:false});
  return {close};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--state')throw new Error('qualification_unavailable');
  await connectTrustedSocket({statePath:args[1]}).catch(error=>{console.error('[computer-qualification] socket_unavailable',error instanceof Error?error.name:'UnknownError');process.exitCode=1;});
}

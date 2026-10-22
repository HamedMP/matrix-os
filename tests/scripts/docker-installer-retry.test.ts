import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

it.each(['Dockerfile','Dockerfile.dev'])('%s recovers from an installer rate limit with bounded downloads',async file=>{
 const line=readFileSync(file,'utf8').split('\n').find(line=>line.startsWith('RUN curl')&&line.includes('hermes-agent'))!;
 const flags=line.slice('RUN curl '.length,line.indexOf('"https:')).trim().split(/\s+/);
 expect(flags).toContain('--retry');
 expect(flags).toContain('--max-time');
 expect(flags).toContain('--retry-max-time');
 let requests=0;
 const server=createServer((_request,response)=>{
  requests++;
  if(requests===1){response.writeHead(429,{'Retry-After':'1'});response.end('retry');}
  else {response.end('installer');}
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw new Error('Test server unavailable');
 try{
  const result=await new Promise<{code:number|null,stdout:string}>((resolve,reject)=>{
   const child=spawn('curl',[...flags,`http://127.0.0.1:${address.port}`],{timeout:10_000});let stdout='';
   child.stdout.on('data',data=>{stdout+=String(data);});child.on('error',reject);child.on('close',code=>resolve({code,stdout}));
  });
  expect(result).toEqual({code:0,stdout:'installer'});expect(requests).toBe(2);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
},15_000);

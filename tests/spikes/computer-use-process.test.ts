import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect,it } from 'vitest';
import { runBoundedProcess,createX11Backend } from '../../scripts/spikes/computer-use/backend.mjs';

it('waits for a real simulated input child to exit on cancellation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'matrix-computer-child-'));const pidfile=join(dir,'pid');
  const control=new AbortController();
  const pending=runBoundedProcess(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",pidfile],{signal:control.signal}).catch((e:Error)=>e.message);
  try {
    let pid:number|undefined;
    for(let i=0;i<100;i++){try{pid=Number(await readFile(pidfile,'utf8'));break;}catch(error){if(!(error instanceof Error && 'code' in error && error.code==='ENOENT'))throw error;}await delay(10);}
    expect(pid).toBeGreaterThan(0);control.abort();expect(await pending).toBe('operation_cancelled');
    expect(()=>process.kill(pid!,0)).toThrow();
  } finally {control.abort();await pending;await rm(dir,{recursive:true,force:true});}
});

it('bounds child output and refuses unsupported native executor before spawn',async()=>{
  await expect(runBoundedProcess(process.execPath,['-e','process.stdout.write(Buffer.alloc(5000))'],{maxBytes:64})).rejects.toThrow('output_limit');
  expect(()=>createX11Backend({platform:'darwin',uid:501})).toThrow('qualification_unavailable');
  expect(()=>createX11Backend({platform:'linux',uid:0})).toThrow('qualification_unavailable');
});

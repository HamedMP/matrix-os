import { expect, it, vi } from 'vitest';
import { createQualificationSession } from '../../scripts/spikes/computer-use/session.mjs';
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=';
const grant = () => ({ ownerId:'owner',chatId:'chat',runId:'run',targetId:'pv-123-1234abcd',display:':7',modelRoute:'approved_vision',syntheticOnly:true,expiresAt:Date.now()+60_000 });
it('cancels held modifiers and refuses late input before reporting stop',async()=>{
  const calls: string[][] = []; let pressed!:()=>void; const didPress = new Promise<void>(r=>pressed=r);
  const backend={capture:async()=>({width:1,height:1,data}),geometry:async()=>({width:1,height:1}),command:async(args:string[],signal:AbortSignal)=>{
    calls.push(args);
    if(args[0]==='keydown'){pressed();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}
  }};
  const session=createQualificationSession({grant:grant(),backend,platform:'linux'});
  const frame=observation(await session.execute({action:'observe'}));
  const action={action:'key',keys:['CTRL'],actionId:'key1',observationId:frame.observationId,leaseEpoch:frame.leaseEpoch,geometryRevision:frame.geometryRevision};
  const pending=session.execute(action).catch((error:Error)=>error.message); await didPress;
  await session.stop(); await pending;
  expect(calls).toEqual([['keydown','CTRL'],['keyup','CTRL']]);
  await expect(session.execute(action)).rejects.toThrow('qualification_unavailable');
});

it('refuses missing/expired grants and non-Linux before capture or input',()=>{
  const backend={capture:()=>{throw new Error('must not capture');}};
  expect(()=>createQualificationSession({grant:{},backend,platform:'linux'})).toThrow();
  expect(()=>createQualificationSession({grant:grant(),backend,platform:'darwin'})).toThrow('qualification_unavailable');
  expect(()=>createQualificationSession({grant:{...grant(),expiresAt:1},backend,platform:'linux'})).toThrow('qualification_unavailable');
  expect(()=>createQualificationSession({grant:{...grant(),targetId:'primary'},backend,platform:'linux'})).toThrow();
});

it('rejects stale frame, wrong epoch, resized display and replay without dispatch',async()=>{
  const calls: string[][]=[]; let width=1; let now=Date.now();
  const session=createQualificationSession({grant:grant(),platform:'linux',now:()=>now,backend:{
    capture:async()=>({width:1,height:1,data}),geometry:async()=>({width,height:1}),command:async(a:string[])=>{calls.push(a);},
  }});
  try {
    let frame=observation(await session.execute({action:'observe'}));
    const action=(f:ReturnType<typeof observation>)=>({action:'click',x:0,y:0,actionId:'click1',observationId:f.observationId,leaseEpoch:f.leaseEpoch,geometryRevision:f.geometryRevision});
    await expect(session.execute({...action(frame),leaseEpoch:999})).rejects.toThrow('observe_again');
    frame=observation(await session.execute({action:'observe'})); width=2;
    await expect(session.execute(action(frame))).rejects.toThrow('observe_again');
    width=1; frame=observation(await session.execute({action:'observe'})); await session.execute(action(frame));
    frame=observation(await session.execute({action:'observe'}));
    await expect(session.execute(action(frame))).rejects.toThrow('action_not_admitted');
    expect(calls).toEqual([['mousemove','--sync','0','0'],['mousedown','1'],['mouseup','1']]);
    now+=5001;
    await expect(session.execute({action:'observe'})).rejects.toThrow('qualification_unavailable');
  } finally { await session.stop(); }
});

it('releases a held drag button on abort and never admits a competing action',async()=>{
  let pressed!:()=>void; const didPress=new Promise<void>(r=>pressed=r); const calls:string[][]=[];
  const session=createQualificationSession({grant:grant(),platform:'linux',backend:{
    capture:async()=>({width:1,height:1,data}),geometry:async()=>({width:1,height:1}),command:async(a:string[])=>{calls.push(a);if(a[0]==='mousedown')pressed();},
  }});
  const f=observation(await session.execute({action:'observe'})); const control=new AbortController();
  const pending=session.execute({action:'drag',points:[{x:0,y:0},{x:0,y:0}],durationMs:2000,actionId:'drag1',observationId:f.observationId,leaseEpoch:f.leaseEpoch,geometryRevision:f.geometryRevision},control.signal).catch((e:Error)=>e.name);
  await didPress;
  await expect(session.execute({action:'observe'})).rejects.toThrow('qualification_busy');
  control.abort(); await pending; await session.stop();
  expect(calls).toEqual([['mousemove','--sync','0','0'],['mousedown','1'],['mouseup','1']]);
});

it('types approved ASCII through tracked down/up pairs and releases wheel buttons',async()=>{
  const calls:string[][]=[];
  const session=createQualificationSession({grant:grant(),platform:'linux',backend:{capture:async()=>({width:1,height:1,data}),geometry:async()=>({width:1,height:1}),command:async(a:string[])=>{calls.push(a);}}});
  const grounded=(f:ReturnType<typeof observation>,id:string)=>({actionId:id,observationId:f.observationId,leaseEpoch:f.leaseEpoch,geometryRevision:f.geometryRevision});
  try {
    let f=observation(await session.execute({action:'observe'}));
    f=observation(await session.execute({action:'type',text:"A_\\'",...grounded(f,'type1')}));
    expect(calls).toEqual([
      ['keydown','SHIFT'],['keydown','A'],['keyup','A'],['keyup','SHIFT'],
      ['keydown','SHIFT'],['keydown','MINUS'],['keyup','MINUS'],['keyup','SHIFT'],
      ['keydown','BACKSLASH'],['keyup','BACKSLASH'],['keydown','APOSTROPHE'],['keyup','APOSTROPHE'],
    ]);
    calls.length=0;
    await session.execute({action:'scroll',x:0,y:0,direction:'down',ticks:2,...grounded(f,'scroll1')});
    expect(calls).toEqual([['mousemove','--sync','0','0'],['mousedown','5'],['mouseup','5'],['mousedown','5'],['mouseup','5']]);
  } finally {await session.stop();}
});

it('latches cleanup failure and cannot resume the unsafe session',async()=>{
  const session=createQualificationSession({grant:grant(),platform:'linux',backend:{capture:async()=>({width:1,height:1,data}),geometry:async()=>({width:1,height:1}),command:async(a:string[])=>{if(a[0]==='keyup')throw new Error('simulated_input_failure');}}});
  const f=observation(await session.execute({action:'observe'}));
  await expect(session.execute({action:'key',keys:['CTRL'],actionId:'key1',observationId:f.observationId,leaseEpoch:f.leaseEpoch,geometryRevision:f.geometryRevision})).rejects.toThrow('cleanup_failed');
  await expect(session.execute({action:'observe'})).rejects.toThrow('qualification_unavailable');
  expect(()=>session.presence()).toThrow('qualification_unavailable');
  await expect(session.stop()).rejects.toThrow('cleanup_failed');
});

it('independently stops an in-flight held key when operator presence expires',async()=>{
  vi.useFakeTimers();
  const calls:string[][]=[];let pressed!:()=>void;const didPress=new Promise<void>(r=>pressed=r);
  const session=createQualificationSession({grant:grant(),platform:'linux',backend:{
    capture:async()=>({width:1,height:1,data}),geometry:async()=>({width:1,height:1}),
    command:async(args:string[],signal:AbortSignal)=>{
      calls.push(args);
      if(args[0]==='keydown'){pressed();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}
    },
  }});
  try {
    const frame=observation(await session.execute({action:'observe'}));
    const pending=session.execute({action:'key',keys:['CTRL'],actionId:'watchdog1',observationId:frame.observationId,leaseEpoch:frame.leaseEpoch,geometryRevision:frame.geometryRevision}).catch((error:Error)=>error.message);
    await didPress;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe('cancelled');
    expect(calls).toEqual([['keydown','CTRL'],['keyup','CTRL']]);
    expect(()=>session.presence()).toThrow('qualification_unavailable');
    await expect(session.execute({action:'observe'})).rejects.toThrow('qualification_unavailable');
  } finally {await session.stop();vi.useRealTimers();}
});

function observation(result:Awaited<ReturnType<ReturnType<typeof createQualificationSession>['execute']>>) {
  if(!('observationId' in result))throw new Error('observation required');
  return result;
}

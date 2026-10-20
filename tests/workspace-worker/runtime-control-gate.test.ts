import {describe,expect,it,vi} from 'vitest';
import {RuntimeControlGate} from '../../packages/workspace-worker/src/runtime/control-gate.js';
describe('bounded native runtime control gate',()=>{
 it('drains an old startup before destruction and replacement',async()=>{
  const gate=new RuntimeControlGate();const events:string[]=[];let release!:()=>void;
  const start=gate.run(async()=>{events.push('start');await new Promise<void>(resolve=>{release=resolve;});events.push('drained');});
  await vi.waitFor(()=>expect(events).toEqual(['start']));
  const stop=gate.run(async()=>{events.push('destroy');});const replacement=gate.run(async()=>{events.push('replacement');});
  expect(events).toEqual(['start']);release();await Promise.all([start,stop,replacement]);
  expect(events).toEqual(['start','drained','destroy','replacement']);
 });
 it('caps waiters and recovers after a rejected operation',async()=>{
  const gate=new RuntimeControlGate();let release!:()=>void;
  const pending=gate.run(()=>new Promise<void>(resolve=>{release=resolve;}));await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const queued=[gate.run(async()=>{}),gate.run(async()=>{throw new Error('control failed');}),gate.run(async()=>{})];
  const results=Promise.allSettled(queued);
  await expect(gate.run(async()=>{})).rejects.toThrow('Runtime busy');release();await pending;
  expect((await results).map(x=>x.status)).toEqual(['fulfilled','rejected','fulfilled']);
  await expect(gate.run(async()=>{})).resolves.toBeUndefined();
 });
});

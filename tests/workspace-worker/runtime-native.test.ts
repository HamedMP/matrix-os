import { describe, expect, it, vi } from 'vitest';
vi.mock('@cloudflare/sandbox', () => ({ DirectoryBackup: class {} }));
import { NativeRuntimeDriver } from '../../packages/workspace-worker/src/runtime/native-driver.js';

function fixture() {
  const commands: Array<{args:string[];options:any}> = [];
  const container = {
    running:false, images:{workspace:'matrix-image'},
    start:vi.fn(() => { container.running = true; }), destroy:vi.fn(async () => {container.running=false;}),
    setInactivityTimeout:vi.fn(async () => undefined),
    exec:vi.fn(async (args:string[],options:any) => {
      commands.push({args,options});
      return {exitCode:Promise.resolve(0),output:async () => ({exitCode:0,stdout:new TextEncoder().encode(args.at(-1)==='export' ? '{"text":"saved","files":[]}' : '{}'),stderr:new Uint8Array()})};
    }),
  };
  const backups = {restore:vi.fn(async () => undefined), backup:vi.fn(async () => ({id:'backup'}))};
  const publish = vi.fn(async () => undefined); const saved = vi.fn(async () => undefined);
  const hydrate = vi.fn(async () => [{path:'note.txt',content:'durable edit'}]);
  const driver = new NativeRuntimeDriver(container as any,backups as any,{
    ANTHROPIC_API_KEY:'execution-secret',RUNTIME_AUTH_SECRET:'runtime-secret',RUNTIME_DATABASE_URL:'postgres://owner@db/runtime',
  },publish,saved,hydrate);
  return {driver,container,backups,publish,saved,hydrate,commands};
}

describe('native Cloudflare runtime adapter', () => {
  it('restores and overlays shared files before starting the actual gateway', async () => {
    const f=fixture(); await f.driver.start('owner',{generation:1,createdAt:0,backup:{id:'old'}},2);
    expect(f.backups.restore).toHaveBeenCalledWith({id:'old'},expect.objectContaining({signal:expect.any(AbortSignal)}));
    expect(f.commands.map(c=>c.args.at(-1))).toEqual(['stop','hydrate','start']);
    expect(f.commands[1].options.stdin).toBeInstanceOf(ReadableStream);
    expect(f.container.start).toHaveBeenCalledWith({image:'matrix-image',enableInternet:true,instance:'standard-2'});
    expect(f.container.start.mock.calls[0]?.[0]).not.toHaveProperty('env');
    expect(f.commands.at(-1)?.options.env.ANTHROPIC_API_KEY).toBe('execution-secret');
    expect(f.commands.at(-1)?.options.env.DATABASE_URL).toBe('postgres://owner@db/runtime');
    expect(f.commands.at(-1)?.options.user).toBe('1000:1000');
  });
  it('drains writers, saves R2 backup, and publishes output before completion', async () => {
    const f=fixture(); const lease={ownerId:'owner',jobId:'job',generation:1,expiresAt:Date.now()+60000,maxRunAt:Date.now()+60000};
    await f.driver.execute({ownerId:'owner',jobId:'job',type:'chat',message:'save'},lease);
    expect(f.commands.map(c=>c.args.at(-1))).toEqual(['execute','stop','export']);
    expect(f.backups.backup).toHaveBeenCalledWith(expect.objectContaining({exclude:expect.arrayContaining(['system/ai-providers/anthropic-key.json'])}));
    const options=f.backups.backup.mock.calls[0][0] as any;
    expect(options.exclude).toContain('.claude/.credentials.json');
    expect(options.exclude).not.toContain('.claude/');
    expect(f.saved.mock.invocationCallOrder[0]).toBeLessThan(f.publish.mock.invocationCallOrder[0]);
  });
  it('does not start compute for a keepalive when it has stopped', async () => {
    const f=fixture(); await f.driver.keepAlive(); expect(f.container.start).not.toHaveBeenCalled(); expect(f.container.exec).not.toHaveBeenCalled();
  });
  it('times out a stalled keepalive without keeping the alarm pending forever', async () => {
    const f=fixture(); f.container.running=true; vi.useFakeTimers();
    try {
      f.container.exec.mockImplementation(async (_args,options) => ({exitCode:new Promise<number>((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})),output:async()=>({exitCode:0,stdout:new Uint8Array(),stderr:new Uint8Array()})}));
      const pending=expect(f.driver.keepAlive()).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(10001); await pending;
    } finally { vi.useRealTimers(); }
  });
  it('does not abort a completed keepalive later', async () => {
    const f=fixture(); f.container.running=true; vi.useFakeTimers();
    try { await f.driver.keepAlive(); const signal=f.commands[0].options.signal; await vi.advanceTimersByTimeAsync(10001); expect(signal.aborted).toBe(false); }
    finally {vi.useRealTimers();}
  });
  it('reports sleeping metrics without waking compute', async () => {
    const f=fixture(); expect(await f.driver.metrics()).toEqual({running:false}); expect(f.container.exec).not.toHaveBeenCalled();
  });
  it('arms a short platform failsafe if explicit destruction fails', async () => {
    const f=fixture(); f.container.running=true; f.container.destroy.mockRejectedValue(new Error('unavailable'));
    await expect(f.driver.cancel({ownerId:'owner',jobId:'job',generation:1,expiresAt:0,maxRunAt:0})).rejects.toThrow('unavailable');
    expect(f.container.setInactivityTimeout).toHaveBeenCalledWith(1000);
  });
  it('enforces the hard task boundary on cancellation', async () => {
    const f=fixture(); f.container.running=true;
    await f.driver.cancel({ownerId:'owner',jobId:'job',generation:1,expiresAt:0,maxRunAt:0}); expect(f.container.destroy).toHaveBeenCalled();
  });
});

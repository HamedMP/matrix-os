import { describe, expect, it, vi } from 'vitest';
import { parseProcMeminfo, readRuntimeMetrics } from '../../packages/workspace-worker/src/runtime/memory-metrics.js';

const meminfo = 'MemTotal:        6291456 kB\nMemFree:           65536 kB\nMemAvailable:    4194304 kB\n';
const encoded = (value:string) => new TextEncoder().encode(value);
function fixture() {
  const exec = vi.fn(async (args:string[], _options:any) => ({
    exitCode:Promise.resolve(0),
    output:async () => ({exitCode:0,stderr:new Uint8Array(),stdout:encoded(args[0]==='cat' ? meminfo : JSON.stringify({cgroupMemoryBytes:0,cgroupPeakBytes:0,gatewayAlive:true,rssKiB:659156,timestamp:123,unexpected:'private'}))}),
  }));
  return {running:true,exec};
}

describe('native VM memory metrics', () => {
  it('computes used VM memory from MemTotal minus MemAvailable in kibibytes', () => {
    expect(parseProcMeminfo(meminfo)).toEqual({vmTotalMemoryBytes:6442450944,vmUsedMemoryBytes:2147483648,memorySource:'proc-meminfo'});
  });
  it.each(['MemTotal: 123 kB', 'MemTotal: 1 kB\nMemAvailable: 2 kB', 'MemTotal: 1 MB\nMemAvailable: 0 kB', 'MemTotal: 0 kB\nMemAvailable: 0 kB', 'MemTotal: 1 kB\nMemAvailable: 0 kB\nMemTotal: 2 kB', 'x'.repeat(16385)])('rejects malformed or oversized memory data', (input) => {
    expect(() => parseProcMeminfo(input)).toThrow('Metrics unavailable');
  });
  it('never executes anything when compute is stopped', async () => {
    const container=fixture(); container.running=false;
    expect(await readRuntimeMetrics(container as any)).toEqual({running:false});
    expect(container.exec).not.toHaveBeenCalled();
  });
  it('reads VM memory separately and emits only safe numeric metrics', async () => {
    const container=fixture();
    const result=await readRuntimeMetrics(container as any);
    expect(result).toEqual({running:true,cgroupMemoryBytes:null,cgroupPeakBytes:null,gatewayAlive:true,rssKiB:659156,timestamp:123,vmTotalMemoryBytes:6442450944,vmUsedMemoryBytes:2147483648,memorySource:'proc-meminfo'});
    expect(container.exec).toHaveBeenLastCalledWith(['cat','/proc/meminfo'],expect.objectContaining({user:'1000:1000',signal:expect.any(AbortSignal)}));
  });
  it('preserves positive cgroup values', async () => {
    const container=fixture();
    container.exec.mockImplementation(async(args) => ({exitCode:Promise.resolve(0),output:async()=>({exitCode:0,stderr:new Uint8Array(),stdout:encoded(args[0]==='cat'?meminfo:'{"cgroupMemoryBytes":100,"cgroupPeakBytes":200}')})}));
    expect(await readRuntimeMetrics(container as any)).toMatchObject({cgroupMemoryBytes:100,cgroupPeakBytes:200});
  });
  it('bounds a stalled process and clears completed timers', async () => {
    const container=fixture(); vi.useFakeTimers();
    try {
      container.exec.mockImplementation(async(_args,options) => ({exitCode:new Promise<number>((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})),output:async()=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))}));
      const pending=expect(readRuntimeMetrics(container as any)).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(10001); await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
  });
  it('rejects oversized process output before parsing', async () => {
    const container=fixture();
    container.exec.mockImplementation(async()=>({exitCode:Promise.resolve(0),output:async()=>({exitCode:0,stderr:new Uint8Array(),stdout:new Uint8Array(17000)})}));
    await expect(readRuntimeMetrics(container as any)).rejects.toThrow('Metrics unavailable');
  });
});

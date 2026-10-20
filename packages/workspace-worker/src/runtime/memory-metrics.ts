const decoder = new TextDecoder();
const MAX_MEMINFO_BYTES = 16 * 1024;

/** Native VMs may lack cgroup accounting; MemAvailable includes reclaimable cache. */
export function parseProcMeminfo(input: string): {
  vmTotalMemoryBytes:number; vmUsedMemoryBytes:number; memorySource:'proc-meminfo';
} {
  if (new TextEncoder().encode(input).byteLength > MAX_MEMINFO_BYTES) throw new Error('Metrics unavailable');
  const field = (name:string):number => {
    const matches = [...input.matchAll(new RegExp(`^${name}:\\s+(\\d+) kB\\s*$`,'gm'))];
    if (matches.length !== 1) throw new Error('Metrics unavailable');
    const bytes = Number(matches[0][1]) * 1024;
    if (!Number.isSafeInteger(bytes)) throw new Error('Metrics unavailable');
    return bytes;
  };
  const total=field('MemTotal'); const available=field('MemAvailable');
  if (total <= 0 || available > total) throw new Error('Metrics unavailable');
  return {vmTotalMemoryBytes:total,vmUsedMemoryBytes:total-available,memorySource:'proc-meminfo'};
}

export async function readRuntimeMetrics(container:Pick<Container,'running'|'exec'>):Promise<unknown> {
  if (!container.running) return {running:false};
  const control = JSON.parse(await boundedOutput(container,
    ['node','packages/workspace-worker/runtime/control.mjs','metrics'],4096));
  const memory = parseProcMeminfo(await boundedOutput(container,['cat','/proc/meminfo'],MAX_MEMINFO_BYTES));
  const positive = (value:unknown):number|null => typeof value==='number' && Number.isSafeInteger(value) && value>0 ? value : null;
  return {
    running:true,
    cgroupMemoryBytes:positive(control.cgroupMemoryBytes),
    cgroupPeakBytes:positive(control.cgroupPeakBytes),
    gatewayAlive:control.gatewayAlive===true,
    rssKiB:positive(control.rssKiB),timestamp:positive(control.timestamp),
    ...memory,
  };
}

async function boundedOutput(container:Pick<Container,'exec'>,args:string[],limit:number):Promise<string> {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10_000);
  try {
    const process=await container.exec(args,{cwd:'/opt/matrix',user:'1000:1000',signal:controller.signal});
    void process.exitCode.then(()=>clearTimeout(timer),()=>clearTimeout(timer));
    const result=await process.output();
    if (result.exitCode!==0 || result.stdout.byteLength>limit) throw new Error('Metrics unavailable');
    return decoder.decode(result.stdout);
  } finally {clearTimeout(timer);}
}

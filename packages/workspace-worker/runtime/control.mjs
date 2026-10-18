import { summarizeGatewayResult } from './result.mjs';
import { runChatJob } from './sessions.mjs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile, rm, lstat, rename } from 'node:fs/promises';

const root = '/tmp/matrix-runtime';
await mkdir(root, { recursive: true, mode: 0o700 });
const operation = process.argv[2];
const pidPath = `${root}/gateway.pid`;
const alive = async () => {
  try {
    const pid = Number(await readFile(pidPath, 'utf8'));
    process.kill(pid, 0);
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    return /^State:\s+Z/m.test(status) ? null : pid;
  }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
};
const request = async (path, body, timeout = 300_000) => {
  const response = await fetch(`http://127.0.0.1:4000${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'authorization': `Bearer ${process.env.MATRIX_AUTH_TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout), redirect: 'error',
  });
  if (!response.ok) throw new Error('Gateway request failed');
  return response;
};
if (operation === 'hydrate') {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 1_000_000) throw new Error('Hydration too large'); }
  const files = JSON.parse(input);
  if (!Array.isArray(files) || files.length > 100) throw new Error('Hydration too large');
  const home = '/workspace/home';
  await mkdir(home, {recursive:true});
  if (!(await lstat(home)).isDirectory()) throw new Error('Unsafe workspace home');
  for (const file of files) {
    if (typeof file.path !== 'string' || file.path.length > 512 || typeof file.content !== 'string'
      || file.path === '.matrix-runtime' || file.path.startsWith('.matrix-runtime/')
      || Buffer.byteLength(file.content) > 128 * 1024 || file.path.startsWith('/') || file.path.includes('\\')) throw new Error('Invalid workspace file');
    const target = resolve(home, file.path);
    const relativePath = relative(home, target);
    if (target === home || relativePath.startsWith('..') || relativePath === '.matrix-runtime'
      || relativePath.startsWith('.matrix-runtime/')) throw new Error('Invalid workspace file');
    let current = home;
    for (const segment of relative(home,dirname(target)).split('/').filter(Boolean)) {
      current += `/${segment}`;
      try { if (!(await lstat(current)).isDirectory()) throw new Error('Unsafe workspace path'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(current); }
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary,file.content,{flag:'wx',mode:0o600}); await rename(temporary,target); }
    finally { await rm(temporary,{force:true}); }
  }
  console.log(JSON.stringify({hydrated:files.length}));
} else if (operation === 'start') {
  if (!await alive()) {
    const log = await open(`${root}/gateway.log`, 'w', 0o600);
    const child = spawn('node', ['--import=tsx', 'packages/workspace-worker/runtime/gateway.ts'], {
      cwd: '/opt/matrix', detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
    });
    await writeFile(pidPath, String(child.pid), { mode: 0o600 }); child.unref(); await log.close();
  }
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { await request('/health', null, 2000); break; }
    catch (error) {
      if (Date.now() > deadline || !await alive()) {
        let detail = await readFile(`${root}/gateway.log`,'utf8').catch((readError) => { if (readError.code==='ENOENT') return 'Gateway log unavailable'; throw readError; });
        for (const value of Object.values(process.env)) { if (value && value.length>=6) detail=detail.split(value).join('[redacted]'); }
        detail=detail.replace(/sk-[A-Za-z0-9_-]+/g,'[redacted-key]').replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[redacted-database]');
        console.error(detail.slice(-4096)); throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.log(JSON.stringify({ ready: true, memory: process.memoryUsage().rss }));
} else if (operation === 'execute') {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 32_768) throw new Error('Job payload too large'); }
  const job = JSON.parse(input);
  if (job.type === 'wake') { console.log(JSON.stringify({ ready: true })); }
  else {
    const result = await runChatJob('/workspace/home', job, request);
    await writeFile('/workspace/home/system/shared-spike-result.json', JSON.stringify(result), { mode: 0o600 });
    console.log(JSON.stringify({ completed: true, events: result.events.length }));
  }
} else if (operation === 'export') {
  const resultFile = '/workspace/home/system/shared-spike-result.json';
  const resultMetadata = await lstat(resultFile).catch((error) => {if(error.code==='ENOENT') return null; throw error;});
  if (resultMetadata && (!resultMetadata.isFile() || resultMetadata.size > 128_000)) throw new Error('Unsafe result file');
  const raw = await readFile(resultFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '{"events":[]}'; throw error;
  });
  if (raw.length > 128_000) throw new Error('Result too large');
  const events = JSON.parse(raw).events ?? [];
  const text = summarizeGatewayResult({events});
  const files = [];
  try {
    const artifact = await lstat('/workspace/home/spike-result.txt');
    if (!artifact.isFile() || artifact.size > 64_000) throw new Error('Unsafe artifact path');
    const content = await readFile('/workspace/home/spike-result.txt', 'utf8');
    if (content.length > 64_000) throw new Error('Artifact too large');
    files.push({path:'spike-result.txt',content});
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(JSON.stringify({text,files}));
} else if (operation === 'stop') {
  const pid = await alive();
  if (pid) {
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 30_000;
    while (await alive()) {
      if (Date.now() > deadline) throw new Error('Gateway did not drain');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(pidPath, { force: true });
} else if (operation === 'metrics') {
  const pid = await alive();
  const status = pid ? await readFile(`/proc/${pid}/status`, 'utf8') : '';
  const memory = await readFile('/sys/fs/cgroup/memory.current','utf8').catch((error) => { if (error.code==='ENOENT') return '0'; throw error; });
  const peak = await readFile('/sys/fs/cgroup/memory.peak','utf8').catch((error) => { if (error.code==='ENOENT') return '0'; throw error; });
  console.log(JSON.stringify({ cgroupMemoryBytes:Number(memory),cgroupPeakBytes:Number(peak),gatewayAlive: !!pid, rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0), timestamp: Date.now() }));
} else { throw new Error('Unknown runtime operation'); }

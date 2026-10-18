import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { cpus, totalmem, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const environmentKeys = new Set(['HOME','PATH','LANG','LC_ALL','CI','NODE_OPTIONS','PNPM_HOME',
  'XDG_CACHE_HOME','XDG_DATA_HOME','PLAYWRIGHT_BROWSERS_PATH','MATRIX_TEST_WORKERS',
  'MATRIX_TEST_BENCHMARK','MATRIX_TEST_PROFILE_SORT','MATRIX_NO_TELEMETRY',
  'MATRIX_PLATFORM_FIXTURE_POSTGRES_URL','MATRIX_TEST_POSTGRES_URL']);

export function isolatedTestJob(host, command, env) {
  if (host.platform !== 'linux' || !Number.isSafeInteger(host.uid) || host.uid < 1
    || !Number.isSafeInteger(host.gid) || host.gid < 1 || !/^[a-f0-9]{24}$/.test(host.unitId)
    || !Number.isSafeInteger(host.totalMemory) || !Number.isInteger(host.cpus) || host.cpus < 2
    || !Array.isArray(command) || !command.length || command.length > 64
    || command.some(arg => typeof arg !== 'string' || !arg.length || arg.length > 4096 || arg.includes('\0'))) {
    throw new Error('Isolated tests require a non-root Linux owner, systemd and a bounded command');
  }
  const memoryMiB = Math.min(6144, Math.floor(host.totalMemory * .45 / 1024 ** 2));
  if (memoryMiB < 2048) throw new Error('Insufficient machine capacity for isolated tests');
  const unit = `matrix-test-${host.uid}-${host.unitId}.service`;
  const directory = join(host.home, '.cache', 'matrix-test-jobs');
  const preserve = Object.keys(env).filter(key => environmentKeys.has(key));
  // Hide the owner bus so provider fixtures cannot reparent outside this job's cgroup.
  const args = ['--quiet','--wait','--pipe','--collect','--service-type=exec','--expand-environment=no',
    `--unit=${unit}`,`--uid=${host.uid}`,`--gid=${host.gid}`,`--working-directory=${host.cwd}`,
    `--property=MemoryMax=${memoryMiB}M`,`--property=MemoryHigh=${memoryMiB}M`,
    '--property=MemorySwapMax=0',`--property=CPUQuota=${Math.min(4,host.cpus-1)*100}%`,
    '--property=TasksMax=2048','--property=Nice=10','--property=RuntimeMaxSec=10800',
    '--property=TimeoutStopSec=10','--property=KillMode=control-group','--property=OOMPolicy=stop','--property=TemporaryFileSystem=/run/user:ro',
    ...preserve.map(key=>key === 'PATH' ? `--setenv=PATH=${env.PATH}` : `--setenv=${key}`),'/usr/bin/flock','--no-fork','--timeout=7200',
    join(directory,'admission.lock'),...command];
  return { unit, args, preserve, directory, memoryMiB };
}

export async function waitForTestJob(child, stop, signals = process) {
  let signalExit, timer;
  const cancel = signal => {
    signalExit ??= signal === 'SIGINT' ? 130 : 143;
    stop(false);
    // The first stop may precede unit creation. Keep draining until the starter closes.
    timer ??= setInterval(() => stop(false), 250);
  };
  const interrupt=()=>cancel('SIGINT'),terminate=()=>cancel('SIGTERM');
  signals.on('SIGINT',interrupt);signals.on('SIGTERM',terminate);
  try {
    return await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve(signalExit??code??(signal?128:1)));
    });
  } finally {
    clearInterval(timer);
    signals.off('SIGINT',interrupt);signals.off('SIGTERM',terminate);
    if (signalExit) stop(true);
  }
}

export async function runIsolatedTestJob(command) {
  const owner = userInfo();
  const host = { platform:process.platform,uid:owner.uid,gid:owner.gid,home:owner.homedir,
    totalMemory:totalmem(),cpus:cpus().length,cwd:process.cwd(),unitId:randomBytes(12).toString('hex') };
  const job = isolatedTestJob(host, command, process.env);
  await mkdir(job.directory,{recursive:true,mode:0o700});
  const info = await lstat(job.directory);
  if (!info.isDirectory() || info.uid !== owner.uid || (info.mode & 0o077)) throw new Error('Untrusted test admission directory');
  const lock = await open(join(job.directory,'admission.lock'),constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  try {
    const info = await lock.stat();
    if (!info.isFile() || info.uid !== owner.uid || (info.mode & 0o077)) throw new Error('Untrusted test admission lock');
  } finally { await lock.close(); }
  console.error(`Isolated test job: ${job.unit}; memory limit ${job.memoryMiB} MiB. Other worktrees queue on the owner admission lock.`);
  const args = ['-n',...(job.preserve.length?[`--preserve-env=${job.preserve.join(',')}`]:[]),'/usr/bin/systemd-run',...job.args];
  const child = spawn('sudo',args,{stdio:'inherit'});
  return waitForTestJob(child, final => {
    const stopped = spawnSync('sudo',['-n','/usr/bin/systemctl','stop',job.unit],{stdio:'ignore',timeout:15000});
    if (final && stopped.status !== 0) console.error('Test job stop was not confirmed; its runtime limit remains active.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv.slice(2);
  if (command[0] === '--') command.shift();
  try { process.exitCode = await runIsolatedTestJob(command); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Isolated test startup failed');process.exitCode=1; }
}

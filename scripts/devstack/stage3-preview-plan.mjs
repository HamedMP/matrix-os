import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { identifyStage3Target } from './stage3-source.mjs';

const exec = promisify(execFile);

/** Produce, but never execute, the candidate preview's Docker argv. Ingress must
 * join the approved private network; no host port or operational mount exists.
 * The reviewed image owns dependency resolution and sends build output to /tmp.
 */
export async function buildStage3PreviewPlan({ mirror, identity, image, name, network, command }) {
  const invalid = () => new Error('Invalid isolated DevStack preview configuration.');
  if (typeof mirror !== 'string' || /[,\r\n]/.test(mirror) || await identifyStage3Target(mirror) !== identity
    || typeof image !== 'string' || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image)
    || typeof name !== 'string' || !/^devstack-preview-[a-z0-9-]{1,48}$/.test(name)
    || typeof network !== 'string' || !/^devstack-[a-z0-9-]{1,48}$/.test(network)
    || !Array.isArray(command) || !command.length || command.length > 57
    || command.some(arg => typeof arg !== 'string' || !arg || arg.length > 4096 || arg.includes('\0'))
    || process.getuid() === 0) throw invalid();
  // Never allow a caller to attach the workload to host/default/external networking.
  const { stdout } = await exec('/usr/bin/docker', ['network', 'inspect', network, '--format', '{{.Internal}}'], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, timeout: 5000, maxBuffer: 1024,
  });
  if (stdout.trim() !== 'true') throw invalid();
  const uid = process.getuid(), gid = process.getgid();
  return ['create', '--pull=never', '--name', name, '--network', network,
    '--read-only', '--user', `${uid}:${gid}`, '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=2g', '--cpus=2', '--ulimit', 'core=0',
    '--mount', `type=bind,src=${mirror},dst=/source,readonly,bind-recursive=disabled`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g,mode=1777', '--workdir=/source', '--entrypoint=/usr/bin/env', image,
    '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp', ...command];
}

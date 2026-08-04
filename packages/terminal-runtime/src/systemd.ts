import { execFile as execFileCallback } from 'node:child_process';
import { readFile as readFileDefault } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  RuntimeIdSchema,
  unitNameForRuntimeId,
} from './contracts.js';
import type {
  SystemdExecutor,
  UnitInspection,
} from './operation-handler.js';

const execFileDefault = promisify(execFileCallback);
const TEMPLATE_PREFIX = 'matrix-terminal-session@';
const TEMPLATE_SUFFIX = '.service';

type RunFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr?: string }>;

type ProcessRoles = {
  keeper: boolean;
  zellijClient: boolean;
  zellijServer: boolean;
  shell: boolean;
};

export function classifyRuntimeProcesses(
  processes: Array<{ comm: string; args: string[] }>,
): ProcessRoles {
  const zellij = processes.filter((process) =>
    process.comm === 'zellij' && !process.args.includes('list-sessions'));
  return {
    keeper: processes.some((process) =>
      process.args.some((argument) => argument.endsWith('/keeper.js'))),
    zellijClient: zellij.length >= 2,
    zellijServer: zellij.length >= 2,
    shell: processes.some((process) =>
      process.comm === 'bash' ||
      process.args.some((argument) => argument.endsWith('/pane.js')) &&
        process.args.includes('agent')),
  };
}

function parseShow(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('systemd_show_invalid');
    const key = line.slice(0, separator);
    if (!['ActiveState', 'SubState', 'ControlGroup'].includes(key)) {
      throw new Error('systemd_show_invalid');
    }
    result[key] = line.slice(separator + 1);
  }
  return result;
}

function unitState(show: Record<string, string>): UnitInspection['unit'] {
  if (show.ActiveState === 'active') return 'active';
  if (show.ActiveState === 'activating') return 'activating';
  if (show.ActiveState === 'failed') return 'failed';
  if (show.ActiveState === 'inactive') return 'inactive';
  return 'missing';
}

function cgroupPopulated(raw: string): boolean {
  const match = raw.match(/(?:^|\n)populated ([01])(?:\n|$)/);
  if (!match) throw new Error('cgroup_events_invalid');
  return match[1] === '1';
}

function cgroupPath(controlGroup: string, runtimeId: string): string {
  const expected = unitNameForRuntimeId(runtimeId);
  if (
    !controlGroup.startsWith('/') ||
    controlGroup.includes('..') ||
    !controlGroup.endsWith(`/${expected}`)
  ) {
    throw new Error('systemd_cgroup_invalid');
  }
  return `/sys/fs/cgroup${controlGroup}`;
}

export function createSystemdExecutor(options: {
  runFile?: RunFile;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  inspectProcesses?: (cgroupPath: string, runtimeId: string) => Promise<ProcessRoles>;
  sessionResponds?: (runtimeId: string) => Promise<boolean>;
} = {}): SystemdExecutor {
  const runFile = options.runFile ?? (async (file, args, runOptions) =>
    await execFileDefault(file, args, runOptions));
  const readFile = options.readFile ?? readFileDefault;
  const inspectProcesses = options.inspectProcesses ?? (async () => ({
    keeper: false,
    zellijClient: false,
    zellijServer: false,
    shell: false,
  }));
  const sessionResponds = options.sessionResponds ?? (async () => false);

  const runSystemctl = async (args: string[]) => await runFile(
    '/usr/bin/systemctl',
    args,
    { timeout: 30_000, maxBuffer: 256 * 1024 },
  );

  const executor: SystemdExecutor = {
    async start(runtimeId) {
      await runSystemctl(['start', unitNameForRuntimeId(runtimeId)]);
    },
    async stop(runtimeId) {
      await runSystemctl(['stop', unitNameForRuntimeId(runtimeId)]);
    },
    async inspect(runtimeId) {
      const id = RuntimeIdSchema.parse(runtimeId);
      let result: { stdout: string };
      try {
        result = await runSystemctl([
          'show',
          unitNameForRuntimeId(id),
          '--property=ActiveState,SubState,ControlGroup',
          '--no-pager',
        ]);
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 4) return null;
        throw error;
      }
      const show = parseShow(result.stdout);
      const unit = unitState(show);
      if (!show.ControlGroup) {
        return {
          runtimeId: id,
          unit,
          cgroupPopulated: false,
          keeperReady: false,
          keeperAlive: false,
          zellijResponsive: false,
          requiredProcessesInCgroup: false,
          resurrection: 'missing',
        };
      }
      const path = cgroupPath(show.ControlGroup, id);
      const [events, roles, responsive] = await Promise.all([
        readFile(`${path}/cgroup.events`, 'utf8'),
        inspectProcesses(path, id),
        sessionResponds(id),
      ]);
      return {
        runtimeId: id,
        unit,
        cgroupPopulated: cgroupPopulated(events),
        keeperReady: unit === 'active' && show.SubState === 'running',
        keeperAlive: roles.keeper,
        zellijResponsive: responsive,
        requiredProcessesInCgroup: roles.keeper && roles.zellijClient &&
          roles.zellijServer && roles.shell,
        resurrection: 'missing',
      };
    },
    async list() {
      const result = await runSystemctl([
        'list-units',
        `${TEMPLATE_PREFIX}*.service`,
        '--all',
        '--plain',
        '--no-legend',
        '--no-pager',
      ]);
      const ids: string[] = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        const unit = line.trim().split(/\s+/, 1)[0];
        if (!unit) continue;
        if (!unit.startsWith(TEMPLATE_PREFIX) || !unit.endsWith(TEMPLATE_SUFFIX)) {
          throw new Error('systemd_list_invalid');
        }
        ids.push(RuntimeIdSchema.parse(
          unit.slice(TEMPLATE_PREFIX.length, -TEMPLATE_SUFFIX.length),
        ));
      }
      const inspections = await Promise.all(
        ids.map(async (id) => await executor.inspect(id)),
      );
      return inspections.filter((value): value is UnitInspection => value !== null);
    },
  };
  return executor;
}

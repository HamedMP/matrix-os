import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runRepair(restartStatus = 0): {
  events: string[];
  repairTriggered: boolean;
  requestedVersion: string;
  result: ReturnType<typeof spawnSync>;
} {
  const root = process.cwd();
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'matrix-update-repair-'));
  temporaryRoots.push(temporaryRoot);

  const appDir = join(temporaryRoot, 'app');
  const commandDir = join(temporaryRoot, 'bin');
  const eventsPath = join(temporaryRoot, 'events');
  const updaterPath = join(temporaryRoot, 'matrix-update');
  mkdirSync(appDir);
  mkdirSync(commandDir);

  const requestedVersion = 'v2026.08.27-1042';
  writeFileSync(join(appDir, '.update-version'), requestedVersion);

  const updater = readFileSync(
    join(root, 'distro/customer-vps/host-bin/matrix-update'),
    'utf8',
  ).replaceAll('/opt/matrix/app', appDir);
  writeExecutable(updaterPath, updater);

  writeExecutable(
    join(commandDir, 'sudo'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'restart:%s\\n' "$*" >> "$MATRIX_TEST_EVENTS"
exit "$MATRIX_TEST_RESTART_STATUS"
`,
  );
  writeExecutable(
    join(commandDir, 'touch'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'trigger:%s\\n' "$*" >> "$MATRIX_TEST_EVENTS"
exec /usr/bin/touch "$@"
`,
  );

  const result = spawnSync('bash', [updaterPath, '--no-tail', 'repair'], {
    cwd: temporaryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MATRIX_TEST_EVENTS: eventsPath,
      MATRIX_TEST_RESTART_STATUS: String(restartStatus),
      PATH: `${commandDir}:${process.env.PATH ?? ''}`,
    },
  });

  const events = readFileSync(eventsPath, 'utf8').trim().split('\n');
  return {
    events,
    repairTriggered: existsSync(join(appDir, '.update-repair-now')),
    requestedVersion: readFileSync(join(appDir, '.update-version'), 'utf8'),
    result,
  };
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe('matrix-update repair', () => {
  it('reloads stale sync-agent code before handing off one repair trigger', () => {
    const { events, repairTriggered, requestedVersion, result } = runRepair();

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(events).toEqual([
      'restart:/usr/bin/timeout --signal=KILL 30 /usr/bin/systemctl restart matrix-sync-agent.service',
      expect.stringMatching(/^trigger:.*\/app\/\.update-repair-now$/),
    ]);
    expect(repairTriggered).toBe(true);
    expect(requestedVersion).toBe('v2026.08.27-1042');
  });

  it('does not let stale code consume a repair trigger when reload fails', () => {
    const { events, repairTriggered, requestedVersion, result } = runRepair(1);

    expect(result.status).toBe(1);
    expect(events).toEqual([
      'restart:/usr/bin/timeout --signal=KILL 30 /usr/bin/systemctl restart matrix-sync-agent.service',
    ]);
    expect(repairTriggered).toBe(false);
    expect(requestedVersion).toBe('v2026.08.27-1042');
  });
});

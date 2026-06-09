import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('start-platform-cloud-run.sh', () => {
  it('waits for the auth shell before starting the platform server', () => {
    const root = process.cwd();
    const script = readFileSync(join(root, 'scripts/start-platform-cloud-run.sh'), 'utf8');

    expect(script).toContain('AUTH_SHELL_READY_TIMEOUT_SEC');
    expect(script).toContain('AUTH_SHELL_READY_PATH:-/');
    expect(script).toContain('curl --fail --silent --show-error --max-time 2');
    expect(script).toContain('http://127.0.0.1:$auth_shell_port$auth_shell_ready_path');
    expect(script).not.toContain('http://127.0.0.1:$auth_shell_port/sign-in');

    const authStartIndex = script.indexOf('node node_modules/next/dist/bin/next start shell');
    const readinessIndex = script.indexOf('if ! wait_for_auth_shell; then');
    const platformStartIndex = script.indexOf('node packages/platform/dist/main.js');
    expect(authStartIndex).toBeGreaterThanOrEqual(0);
    expect(readinessIndex).toBeGreaterThan(authStartIndex);
    expect(platformStartIndex).toBeGreaterThan(readinessIndex);
  });

  it('exits nonzero when the auth shell never becomes ready', () => {
    const root = process.cwd();
    const script = readFileSync(join(root, 'scripts/start-platform-cloud-run.sh'), 'utf8');

    expect(script).toContain('Auth shell did not become ready');
    expect(script).toContain('exit 1');
    expect(script).toContain('kill -0 "$auth_shell_pid"');
    expect(script).toContain('*) auth_shell_ready_path="/$auth_shell_ready_path" ;;');
  });

  it('stops the sibling process when either child exits unexpectedly', () => {
    const root = process.cwd();
    const script = readFileSync(join(root, 'scripts/start-platform-cloud-run.sh'), 'utf8');

    expect(script).toContain('Platform server exited unexpectedly');
    expect(script).toContain('Auth shell exited unexpectedly');
    expect(script).toContain('shutdown');
    expect(script).toContain("trap 'shutdown; exit 143' INT TERM");
  });
});

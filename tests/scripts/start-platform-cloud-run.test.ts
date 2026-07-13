import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('start-platform-cloud-run.sh', () => {
  it('waits for the auth shell before starting the platform server', () => {
    const root = process.cwd();
    const script = readFileSync(join(root, 'scripts/start-platform-cloud-run.sh'), 'utf8');

    expect(script).toContain('AUTH_SHELL_READY_TIMEOUT_SEC');
    expect(script).toContain('AUTH_SHELL_READY_PATH:-/icon-192.png');
    expect(script).toContain('curl --fail --silent --show-error --max-time 2');
    expect(script).toContain('http://127.0.0.1:$auth_shell_port$auth_shell_ready_path');
    expect(script).not.toContain('http://127.0.0.1:$auth_shell_port/sign-in');
    expect(script).toContain('*) auth_shell_ready_path="/$auth_shell_ready_path" ;;');

    const authStartIndex = script.indexOf('node node_modules/next/dist/bin/next start shell');
    const readinessIndex = script.indexOf('if ! wait_for_auth_shell; then');
    const platformStartIndex = script.indexOf('node packages/platform/dist/main.js');
    expect(authStartIndex).toBeGreaterThanOrEqual(0);
    expect(readinessIndex).toBeGreaterThan(authStartIndex);
    expect(platformStartIndex).toBeGreaterThan(readinessIndex);
  });

  it('installs the readiness probe client in the platform runtime image', () => {
    const root = process.cwd();
    const dockerfile = readFileSync(join(root, 'Dockerfile.platform'), 'utf8');

    expect(dockerfile).toContain('ca-certificates');
    expect(dockerfile).toContain('curl');
  });

  it('packages compiled gateway integration modules used by platform startup', () => {
    const root = process.cwd();
    const dockerfile = readFileSync(join(root, 'Dockerfile.platform'), 'utf8');
    const platformStartup = readFileSync(join(root, 'packages/platform/src/platform-startup.ts'), 'utf8');

    expect(platformStartup).toContain("../../gateway/dist/integrations/routes.js");
    expect(platformStartup).toContain("../../gateway/dist/integrations/pipedream.js");
    expect(platformStartup).toContain("../../gateway/dist/platform-db.js");
    expect(dockerfile).toContain("COPY packages/gateway/package.json packages/gateway/package.json");
    expect(dockerfile).toContain("COPY packages/kernel/package.json packages/kernel/package.json");
    expect(dockerfile).toContain("COPY packages/mcp-browser/package.json packages/mcp-browser/package.json");
    expect(dockerfile).toContain("COPY packages/sync-client/package.json packages/sync-client/package.json");
    expect(dockerfile).toContain("RUN pnpm --filter '@matrix-os/gateway' build");
    expect(dockerfile).toContain("/app/packages/gateway/dist ./packages/gateway/dist");
    expect(dockerfile).toContain("/app/packages/kernel/dist ./packages/kernel/dist");
    expect(dockerfile).toContain("/app/packages/gateway/package.json ./packages/gateway/package.json");
    expect(dockerfile).toContain("/app/packages/kernel/package.json ./packages/kernel/package.json");
    expect(dockerfile).toContain("/app/packages/mcp-browser/package.json ./packages/mcp-browser/package.json");
    expect(dockerfile).toContain("/app/packages/sync-client/package.json ./packages/sync-client/package.json");
  });

  it('packages shared contracts imported by the compiled platform server', () => {
    const root = process.cwd();
    const dockerfile = readFileSync(join(root, 'Dockerfile.platform'), 'utf8');
    const platformPackage = readFileSync(join(root, 'packages/platform/package.json'), 'utf8');

    expect(platformPackage).toContain('"@matrix-os/contracts": "workspace:*"');
    expect(dockerfile).toContain('COPY packages/contracts/package.json packages/contracts/package.json');
    expect(dockerfile).toContain('/app/packages/contracts/package.json ./packages/contracts/package.json');
    expect(dockerfile).toContain('/app/packages/contracts/src ./packages/contracts/src');
  });

  it('exits nonzero when the auth shell never becomes ready', () => {
    const root = process.cwd();
    const script = readFileSync(join(root, 'scripts/start-platform-cloud-run.sh'), 'utf8');

    expect(script).toContain('Auth shell did not become ready');
    expect(script).toContain('exit 1');
    expect(script).toContain('kill -0 "$auth_shell_pid"');
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

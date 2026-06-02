import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildProbeWebSocketUrl,
  redactProbeUrl,
  selectProbeMachine,
  shouldRestartCloudflared,
} from '../../scripts/cloudflared-ws-watchdog.mjs';

describe('cloudflared websocket watchdog', () => {
  it('selects a healthy running customer machine for public websocket probes', () => {
    const machine = selectProbeMachine({
      machines: [
        {
          handle: 'stopped',
          clerkUserId: 'user_stopped',
          runtimeSlot: 'primary',
          status: 'stopped',
          healthy: true,
        },
        {
          handle: 'alice',
          clerkUserId: 'user_alice',
          runtimeSlot: 'primary',
          status: 'running',
          healthy: true,
        },
      ],
    });

    expect(machine).toEqual({
      handle: 'alice',
      clerkUserId: 'user_alice',
      runtimeSlot: 'primary',
    });
  });

  it('builds tokenized public websocket URLs for shell and terminal probes', () => {
    expect(buildProbeWebSocketUrl('https://app.matrix-os.com', '/ws', 'jwt-token').toString()).toBe(
      'wss://app.matrix-os.com/ws?token=jwt-token',
    );
    expect(
      buildProbeWebSocketUrl(
        'https://app.matrix-os.com/',
        '/ws/terminal/session?session=main&fromSeq=0',
        'jwt-token',
      ).toString(),
    ).toBe('wss://app.matrix-os.com/ws/terminal/session?session=main&fromSeq=0&token=jwt-token');
  });

  it('redacts probe tokens before logging URLs', () => {
    expect(redactProbeUrl('wss://app.matrix-os.com/ws?token=jwt-token&fromSeq=0')).toBe(
      'wss://app.matrix-os.com/ws?token=REDACTED&fromSeq=0',
    );
  });

  it('restarts cloudflared only after repeated consecutive failures', () => {
    expect(shouldRestartCloudflared(1, 3)).toBe(false);
    expect(shouldRestartCloudflared(2, 3)).toBe(false);
    expect(shouldRestartCloudflared(3, 3)).toBe(true);
  });

  it('ships the watchdog in the production platform compose surface', () => {
    const root = process.cwd();
    const compose = readFileSync(join(root, 'distro/docker-compose.platform.yml'), 'utf8');
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');

    expect(compose).toContain('cloudflared-watchdog:');
    expect(compose).toContain('scripts/cloudflared-ws-watchdog.mjs');
    expect(compose).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(compose).toContain('CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD');
    expect(dockerfile).toContain('COPY scripts/cloudflared-ws-watchdog.mjs ./scripts/cloudflared-ws-watchdog.mjs');
  });
});

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function restoreWithFailure(failedService: string) {
  const root = mkdtempSync(join(tmpdir(), 'matrix-rollback-services-'));
  try {
    writeFileSync(join(root, 'systemd.activity'), 'matrix-hermes.service:active\nmatrix-gateway.service:active\n');
    const recovery = readFileSync('distro/customer-vps/host-bin/matrix-sync-agent-recovery', 'utf8');
    const functionSource = recovery.match(/resume_update_transaction_services\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(functionSource).toBeDefined();
    const result = spawnSync('bash', ['-c', `
UPDATE_TRANSACTION_DIR="$1"
FAILED_SERVICE="$2"
update_payload_name_was_added() { return 1; }
sudo() {
  printf '%s\\n' "$*" >> "$UPDATE_TRANSACTION_DIR/events"
  [ "${'${@: -1}'}" != "$FAILED_SERVICE" ]
}
log() { printf '%s\\n' "$*" >> "$UPDATE_TRANSACTION_DIR/logs"; }
${functionSource}
resume_update_transaction_services
`, 'rollback-test', root, failedService], { encoding: 'utf8' });
    return {
      status: result.status,
      events: readFileSync(join(root, 'events'), 'utf8').trim().split('\n'),
      logs: existsSync(join(root, 'logs')) ? readFileSync(join(root, 'logs'), 'utf8').trim() : '',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('update transaction service recovery', () => {
  it('restores the gateway even if optional Hermes installation fails', () => {
    const result = restoreWithFailure('matrix-hermes.service');
    expect(result.status).toBe(0);
    expect(result.events).toContain('systemctl start --no-block matrix-hermes.service');
    expect(result.events).toContain('systemctl start matrix-gateway.service');
    expect(result.logs).toContain('matrix-hermes.service');
  });

  it('retains the transaction when a core service cannot start', () => {
    const result = restoreWithFailure('matrix-gateway.service');
    expect(result.status).toBe(1);
  });
});

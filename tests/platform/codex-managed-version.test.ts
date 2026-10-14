import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CODEX_VERIFIED_VERSION } from '../../packages/contracts/src/index.js';
import { SCOPE_RUNTIME_CODEX_HARNESS_VERSION } from '../../packages/scope-runtime/src/worker-common.js';
import { CODEX_EXEC_CONTRACT } from '../../packages/gateway/src/coding-agents/codex-version.js';
import { CODEX_APP_SERVER_CONTRACT } from '../../packages/gateway/src/coding-agents/codex-app-server-version.js';

describe('explicitly promoted managed Codex version', () => {
  it('uses 0.162.1 only after both protocol contracts record it on both native targets', () => {
    expect(CODEX_VERIFIED_VERSION).toBe('0.162.1');
    expect(CODEX_EXEC_CONTRACT.verifiedVersions[CODEX_VERIFIED_VERSION]).toBeDefined();
    const app = CODEX_APP_SERVER_CONTRACT.verifiedVersions[CODEX_VERIFIED_VERSION];
    expect(app).toHaveProperty('schemaSha256ByTarget.linux-x64');
    expect(app).toHaveProperty('schemaSha256ByTarget.darwin-arm64');
  });
  it('keeps every consumer of the managed executable on the promoted version', () => {
    expect(SCOPE_RUNTIME_CODEX_HARNESS_VERSION).toBe(CODEX_VERIFIED_VERSION);
    for (const path of ['distro/customer-vps/host-bin/matrix-install-tool-pack', 'distro/customer-vps/host-bin/matrix-install-developer-tools']) {
      expect(readFileSync(path, 'utf8')).toContain(`CODEX_VERSION="${CODEX_VERIFIED_VERSION}"`);
    }
    for (const path of ['Dockerfile', 'Dockerfile.dev']) {
      expect(readFileSync(path, 'utf8')).toContain(`ARG CODEX_VERSION=${CODEX_VERIFIED_VERSION}`);
    }
  });
});

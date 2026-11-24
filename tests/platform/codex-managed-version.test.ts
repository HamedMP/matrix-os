import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CODEX_VERIFIED_VERSION } from '../../packages/contracts/src/index.js';
import { SCOPE_RUNTIME_PROFILE_DIGEST } from '../../packages/scope-runtime/src/profile.js';
import { SCOPE_RUNTIME_CODEX_HARNESS_VERSION } from '../../packages/scope-runtime/src/worker-common.js';
import { CODEX_EXEC_CONTRACT } from '../../packages/gateway/src/coding-agents/codex-version.js';
import { CODEX_APP_SERVER_CONTRACT } from '../../packages/gateway/src/coding-agents/codex-app-server-version.js';

describe('managed Codex version ownership', () => {
  it('qualifies the promoted version on both native targets', () => {
    expect(CODEX_VERIFIED_VERSION).toBe('0.171.0');
    expect(CODEX_EXEC_CONTRACT.verifiedVersions[CODEX_VERIFIED_VERSION]).toBeDefined();
    const app = CODEX_APP_SERVER_CONTRACT.verifiedVersions[CODEX_VERIFIED_VERSION];
    // A release records either one target-independent digest or one per target.
    for (const target of ['linux-x64', 'darwin-arm64']) {
      const digest = 'schemaSha256ByTarget' in app! ? app.schemaSha256ByTarget[target] : app!.schemaSha256;
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it('keeps every consumer of the managed executable on the promoted version', () => {
    expect(SCOPE_RUNTIME_CODEX_HARNESS_VERSION).toBe(CODEX_VERIFIED_VERSION);
    const acceptance = readFileSync('scripts/spikes/collaboration/production-supervisor-acceptance.mjs', 'utf8');
    expect(acceptance).toContain(`const EXPECTED_CODEX_VERSION = \"${CODEX_VERIFIED_VERSION}\"`);
    expect(acceptance).toContain(`const EXPECTED_PROFILE_DIGEST = \"${SCOPE_RUNTIME_PROFILE_DIGEST}\"`);
    for (const path of ['distro/customer-vps/host-bin/matrix-install-tool-pack', 'distro/customer-vps/host-bin/matrix-install-developer-tools']) {
      expect(readFileSync(path, 'utf8')).toContain(`CODEX_VERSION="${CODEX_VERIFIED_VERSION}"`);
    }
    for (const path of ['Dockerfile', 'Dockerfile.dev']) {
      expect(readFileSync(path, 'utf8')).toContain(`ARG CODEX_VERSION=${CODEX_VERIFIED_VERSION}`);
    }
  });
});

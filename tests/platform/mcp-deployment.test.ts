import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('hosted MCP deployment contract', () => {
  it('keeps optional MCP settings in every deployment with comma-safe origins', () => {
    const workflow = readFileSync('.github/workflows/platform-cloud-run.yml', 'utf8');
    for (const key of ['MATRIX_MCP_ENABLED', 'MATRIX_MCP_RESOURCE_URL', 'MATRIX_MCP_OAUTH_ISSUER',
      'MATRIX_MCP_OAUTH_JWKS_URL', 'MATRIX_MCP_ALLOWED_ORIGINS']) {
      expect(workflow).toContain(key + ': ${{ vars.' + key);
      expect(workflow).toContain(key + '=${' + key + '}');
    }
    expect(workflow).toContain('--set-env-vars "^|^');
    expect(workflow).toContain("MCP configuration cannot contain the deployment delimiter");
    expect(workflow).toContain("vars.MATRIX_MCP_ENABLED || 'false'");
  });
});

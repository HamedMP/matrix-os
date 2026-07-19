import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import codexContract from '../../packages/gateway/src/coding-agents/codex-exec-contract.json' with { type: 'json' };
import {
  DEFAULT_DEVELOPER_TOOLS,
  DeveloperToolsSchema,
  parseDeveloperToolsJson,
  serializeDeveloperTools,
} from '../../packages/platform/src/developer-tools.js';

describe('developer tool selection schema', () => {
  it('accepts the four v1 developer tool ids', () => {
    expect(DeveloperToolsSchema.parse(['codex', 'claude-code', 'opencode', 'pi'])).toEqual([
      'codex',
      'claude-code',
      'opencode',
      'pi',
    ]);
  });

  it('rejects unknown developer tool ids', () => {
    expect(() => DeveloperToolsSchema.parse(['codex', 'cursor'])).toThrow();
  });

  it('defaults omitted or malformed persisted values to all tools', () => {
    expect(parseDeveloperToolsJson(null)).toEqual(DEFAULT_DEVELOPER_TOOLS);
    expect(parseDeveloperToolsJson('not-json')).toEqual(DEFAULT_DEVELOPER_TOOLS);
  });

  it('deduplicates and serializes selected tools in canonical order', () => {
    expect(serializeDeveloperTools(['pi', 'codex', 'pi'])).toBe('["codex","pi"]');
  });

  it('pins automated Codex installs and installed-state checks to the verified version', async () => {
    const toolPack = await readFile(fileURLToPath(new URL(
      '../../distro/customer-vps/host-bin/matrix-install-tool-pack',
      import.meta.url,
    )), 'utf8');
    const developerTools = await readFile(fileURLToPath(new URL(
      '../../distro/customer-vps/host-bin/matrix-install-developer-tools',
      import.meta.url,
    )), 'utf8');

    expect(toolPack).toContain(`CODEX_VERSION="${codexContract.latestVerifiedVersion}"`);
    expect(toolPack).toContain('"@openai/codex@${CODEX_VERSION}"');
    expect(developerTools).toContain(`CODEX_VERSION="${codexContract.latestVerifiedVersion}"`);
    expect(developerTools).toContain('codex_version_is_current');
  });
});

import { describe, expect, it } from 'vitest';
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
});

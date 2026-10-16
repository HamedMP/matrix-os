import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const script = 'scripts/ci/platform-google-analytics-env.sh';
function run(mode: string, values: Record<string, string> = {}) {
  return spawnSync('bash', [script, mode], { encoding: 'utf8', env: {
    PATH: process.env.PATH, GOOGLE_TAG_MANAGER_ID: '', GOOGLE_ANALYTICS_MEASUREMENT_ID: '',
    GOOGLE_ANALYTICS_API_SECRET_VERSION: '', ...values,
  } });
}
describe('Google billing deployment configuration', () => {
  it('keeps background delivery disabled without a configured destination', () => {
    expect(run('validate').status).toBe(0);
    expect(run('env-bindings').stdout).toBe('|GOOGLE_TAG_MANAGER_ID=GTM-5D8ZT4HF|GOOGLE_ANALYTICS_MEASUREMENT_ID=');
    expect(run('secret-bindings').stdout).toBe('');
  });
  it('binds the configured destination and pinned private secret together', () => {
    const env = { GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-JJS1LJGEBS', GOOGLE_ANALYTICS_API_SECRET_VERSION: '2' };
    expect(run('validate', env).status).toBe(0);
    expect(run('env-bindings', env).stdout).toContain('|GOOGLE_ANALYTICS_MEASUREMENT_ID=G-JJS1LJGEBS');
    expect(run('secret-bindings', env).stdout).toBe(',GOOGLE_ANALYTICS_API_SECRET=google-analytics-billing-api-secret:2');
  });
  it('rejects malformed identifiers, deploy delimiters and unpinned secrets', () => {
    for (const env of [{ GOOGLE_TAG_MANAGER_ID: 'GTM-X|BAD=true' },
      { GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-X|BAD=true' },
      { GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-ABC', GOOGLE_ANALYTICS_API_SECRET_VERSION: 'latest' }]) {
      expect(run('validate', env).status).not.toBe(0);
      expect(run('env-bindings', env).stdout).toBe('');
      expect(run('secret-bindings', env).stdout).toBe('');
    }
  });
});

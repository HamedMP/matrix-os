import { describe, expect, it } from 'vitest';
import { buildPostAuthRedirectPath, normalizePostAuthRedirectPath } from '../../packages/platform/src/request-routing.js';

const state = 'a'.repeat(41) + '_-';
const target = `/auth/gmail?state=${state}`;

describe.each([
  ['build', buildPostAuthRedirectPath],
  ['normalize', normalizePostAuthRedirectPath],
] as const)('%s Gmail consent sign-in return', (_name, redirect) => {
  it('preserves the exact valid state and drops unrelated consent parameters', () => {
    expect(redirect(`https://app.matrix-os.com${target}&scope=mail&owner=other&client_id=secret#fragment`)).toBe(target);
  });

  it('keeps the existing validated runtime selection', () => {
    expect(redirect(`${target}&runtime=staging&session=private`)).toBe(`/auth/gmail?runtime=staging&state=${state}`);
  });

  it('preserves state after the existing path normalization', () => {
    expect(redirect(`https://app.matrix-os.com//auth/gmail?state=${state}`)).toBe(target);
  });

  it.each([
    '', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '.',
    'a'.repeat(42) + '%00', 'a'.repeat(42) + '%0a', 'a'.repeat(42) + '%7f',
    'a'.repeat(42) + '%2b', 'a'.repeat(42) + '%2f',
    'a'.repeat(42) + '\nZ',
  ])('drops malformed state %j', value => {
    expect(redirect(`/auth/gmail?state=${value}`)).toBe('/auth/gmail');
  });

  it.each([
    `state=${state}&state=${state}`,
    `state=${state}&%73tate=${state}`,
    `state=${state}&state=`,
    `State=${state}`,
    `state%00=${state}`,
  ])('does not accept duplicate or lookalike keys %s', query => {
    expect(redirect(`/auth/gmail?${query}`)).toBe('/auth/gmail');
  });

  it.each(['/auth/gmail/', '/auth/gmail/extra', '/auth/gmail-lookalike', '/auth/%67mail', '/api/integrations/gmail/oauth/callback', '/sign-in'])('does not preserve state on %s', path => {
    expect(redirect(`${path}?state=${state}`)).toBe(path === '/sign-in' ? '/' : path);
  });
});

describe('normalized Gmail return origin', () => {
  it.each([`https://other.example${target}`, `//other.example${target}`])('rejects external target %s', value => {
    expect(normalizePostAuthRedirectPath(value)).toBe('/');
  });
});

import { describe, expect, it } from 'vitest';
import { GmailConnectionMethodSchema, GmailConnectionOptionsSchema, GMAIL_CONNECTION_METHOD_LABELS } from '../../packages/contracts/src/integration-marketplace.js';
describe('Gmail connection capabilities', () => {
  it('accepts bounded unique choices and an included default', () => {
    expect(GmailConnectionOptionsSchema.parse({ methods: ['matrix', 'pipedream'], defaultMethod: 'matrix' })).toEqual({ methods: ['matrix', 'pipedream'], defaultMethod: 'matrix' });
    expect(GmailConnectionOptionsSchema.parse({ methods: ['pipedream'], defaultMethod: 'pipedream' }).methods).toEqual(['pipedream']);
    expect(GMAIL_CONNECTION_METHOD_LABELS).toEqual({ matrix: 'Connect with Matrix (internal preview)', pipedream: 'Connect with Pipedream' });
  });
  it.each([{ methods: [], defaultMethod: 'matrix' }, { methods: ['pipedream'], defaultMethod: 'matrix' },
    { methods: ['matrix', 'matrix'], defaultMethod: 'matrix' }, { methods: ['matrix', 'pipedream', 'matrix'], defaultMethod: 'matrix' },
    { methods: ['public'], defaultMethod: 'public' }])('rejects invalid capabilities %j', value => expect(GmailConnectionOptionsSchema.safeParse(value).success).toBe(false));
  it('accepts only explicit known methods', () => { expect(GmailConnectionMethodSchema.safeParse('matrix').success).toBe(true); expect(GmailConnectionMethodSchema.safeParse('google').success).toBe(false); });
});

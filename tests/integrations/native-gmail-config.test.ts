import { describe, expect, it } from 'vitest';
import { loadNativeGmailConfig } from '../../packages/gateway/src/integrations/native-gmail/config.js';
const env = { GMAIL_OAUTH_ENABLED: 'true', GMAIL_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com', GMAIL_OAUTH_CLIENT_SECRET: 'google-secret',
  GMAIL_OAUTH_CALLBACK_URL: 'https://app.matrix-os.com/api/integrations/gmail/oauth/callback', GMAIL_CREDENTIAL_ENCRYPTION_KEY: '12'.repeat(32) };
describe('native Gmail startup config', () => {
  it('is off until explicitly configured', () => expect(loadNativeGmailConfig({})).toBeNull());
  it('retains complete credentials for cleanup when new consent and mailbox access are off', () => {
    expect(loadNativeGmailConfig({ ...env, GMAIL_OAUTH_ENABLED: 'false' })).toMatchObject({ clientId: env.GMAIL_OAUTH_CLIENT_ID });
  });
  it('rejects partially retained cleanup credentials instead of claiming cleanup is available', () => {
    expect(() => loadNativeGmailConfig({ GMAIL_OAUTH_ENABLED: 'false', GMAIL_OAUTH_CLIENT_ID: env.GMAIL_OAUTH_CLIENT_ID }))
      .toThrow('Gmail OAuth configuration unavailable');
  });
  it('validates complete configuration', () => expect(loadNativeGmailConfig(env)).toMatchObject({ clientId: env.GMAIL_OAUTH_CLIENT_ID, redirectUri: env.GMAIL_OAUTH_CALLBACK_URL, encryptionKey: Buffer.from('12'.repeat(32), 'hex') }));
  it.each(['GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET', 'GMAIL_OAUTH_CALLBACK_URL', 'GMAIL_CREDENTIAL_ENCRYPTION_KEY'])('fails closed when %s missing', key => {
    const invalid: Record<string, string | undefined> = { ...env, [key]: undefined }; expect(() => loadNativeGmailConfig(invalid)).toThrow('Gmail OAuth configuration unavailable');
  });
  it.each(['http://app.matrix-os.com/api/integrations/gmail/oauth/callback', 'https://app.matrix-os.com/wrong', 'https://x:secret@app.matrix-os.com/api/integrations/gmail/oauth/callback', `${env.GMAIL_OAUTH_CALLBACK_URL}?secret=x`])('rejects invalid callback %s', redirect => expect(() => loadNativeGmailConfig({ ...env, GMAIL_OAUTH_CALLBACK_URL: redirect })).toThrow());
  it('requires a dedicated key', () => expect(() => loadNativeGmailConfig({ ...env, PLATFORM_SECRET: env.GMAIL_CREDENTIAL_ENCRYPTION_KEY })).toThrow());
  it('rejects a reused encryption key expressed in a different encoding', () => {
    expect(() => loadNativeGmailConfig({ ...env, MCP_CREDENTIAL_ENCRYPTION_KEY: Buffer.from(env.GMAIL_CREDENTIAL_ENCRYPTION_KEY, 'hex').toString('base64') })).toThrow();
  });
  it('never puts configuration secrets in errors', () => {
    try { loadNativeGmailConfig({ ...env, GMAIL_CREDENTIAL_ENCRYPTION_KEY: 'private-secret' }); }
    catch (error) { expect(String(error)).not.toContain('private-secret'); expect(String(error)).not.toContain('google-secret'); }
  });
});

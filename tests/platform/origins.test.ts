import { describe, it, expect } from 'vitest';
import { appOrigin, apiOrigin, wwwOrigin, resolveReturnPath, appReturnUrl } from '../../packages/platform/src/origins.js';

describe('platform/origins', () => {
  describe('origin resolution', () => {
    it('uses configured origins, normalized to the URL origin', () => {
      const env = { MATRIX_APP_ORIGIN: 'https://app.staging.matrix-os.com/', MATRIX_API_ORIGIN: 'https://api.staging.matrix-os.com', MATRIX_WWW_ORIGIN: 'https://staging.matrix-os.com' } as NodeJS.ProcessEnv;
      expect(appOrigin(env)).toBe('https://app.staging.matrix-os.com');
      expect(apiOrigin(env)).toBe('https://api.staging.matrix-os.com');
      expect(wwwOrigin(env)).toBe('https://staging.matrix-os.com');
    });

    it('resolves app and api origins from their own fallback chains (no cross-leak)', () => {
      expect(appOrigin({ NEXT_PUBLIC_MATRIX_APP_URL: 'https://app.x.com' } as NodeJS.ProcessEnv)).toBe('https://app.x.com');
      // PLATFORM_PUBLIC_URL (the API URL) must NOT become the app origin.
      expect(appOrigin({ PLATFORM_PUBLIC_URL: 'https://api.x.com' } as NodeJS.ProcessEnv)).toBe('https://app.matrix-os.com');
      // It IS the correct fallback for apiOrigin.
      expect(apiOrigin({ PLATFORM_PUBLIC_URL: 'https://api.x.com' } as NodeJS.ProcessEnv)).toBe('https://api.x.com');
      expect(appOrigin({} as NodeJS.ProcessEnv)).toBe('https://app.matrix-os.com');
      expect(apiOrigin({} as NodeJS.ProcessEnv)).toBe('https://api.matrix-os.com');
      expect(wwwOrigin({} as NodeJS.ProcessEnv)).toBe('https://matrix-os.com');
    });

    it('repairs schemeless/bare-host misconfigs instead of emitting an opaque "null" origin', () => {
      // new URL('localhost:3000').origin === 'null' — must never reach a redirect.
      expect(appOrigin({ MATRIX_APP_ORIGIN: 'localhost:3000' } as NodeJS.ProcessEnv)).toBe('https://localhost:3000');
      expect(appOrigin({ MATRIX_APP_ORIGIN: 'app.example.com' } as NodeJS.ProcessEnv)).toBe('https://app.example.com');
    });
  });

  describe('resolveReturnPath', () => {
    it('accepts allowlisted same-origin paths', () => {
      expect(resolveReturnPath('/')).toBe('/');
      expect(resolveReturnPath('/sign-in')).toBe('/sign-in');
      expect(resolveReturnPath('/sign-up?redirect=1')).toBe('/sign-up?redirect=1');
      expect(resolveReturnPath('/runtime')).toBe('/runtime');
      expect(resolveReturnPath('/onboarding/computer')).toBe('/onboarding/computer');
      expect(resolveReturnPath('/vm/alice')).toBe('/vm/alice');
      expect(resolveReturnPath('/auth/device?user_code=BCDF-GHJK')).toBe('/auth/device?user_code=BCDF-GHJK');
    });

    it('rejects off-allowlist and malicious paths, falling back to "/"', () => {
      expect(resolveReturnPath(undefined)).toBe('/');
      expect(resolveReturnPath('')).toBe('/');
      expect(resolveReturnPath('/admin')).toBe('/');          // not on the allowlist
      expect(resolveReturnPath('/onboarding/computer/other')).toBe('/');
      expect(resolveReturnPath('https://evil.com')).toBe('/'); // absolute URL
      expect(resolveReturnPath('//evil.com')).toBe('/');       // protocol-relative
      expect(resolveReturnPath('/\\evil.com')).toBe('/');      // backslash
      expect(resolveReturnPath('/../etc/passwd')).toBe('/');   // traversal
      expect(resolveReturnPath('/vm/../admin')).toBe('/');     // traversal within allowed prefix
      expect(resolveReturnPath('/sign-in\nSet-Cookie: x')).toBe('/'); // control char / header injection
    });
  });

  describe('appReturnUrl', () => {
    it('builds an absolute app-origin URL from a validated path', () => {
      const env = { MATRIX_APP_ORIGIN: 'https://app.matrix-os.com' } as NodeJS.ProcessEnv;
      expect(appReturnUrl('/sign-in', env)).toBe('https://app.matrix-os.com/sign-in');
      expect(appReturnUrl('https://evil.com', env)).toBe('https://app.matrix-os.com/');
    });
  });
});

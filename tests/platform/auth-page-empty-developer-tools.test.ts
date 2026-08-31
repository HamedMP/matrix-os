import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthPage } from '../../packages/platform/src/auth-pages.js';

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for inline auth fallback state');
}

describe('inline auth fallback continuation', () => {
  const openDoms: JSDOM[] = [];

  afterEach(() => {
    for (const dom of openDoms.splice(0)) dom.window.close();
    vi.restoreAllMocks();
  });

  it('keeps a checkout return passive until app-session can expose the authorized runtime', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    let appSessionAttempts = 0;
    const html = getAuthPage(
      'pk_test_matrix',
      'sign-up',
      'test-nonce',
      '/?checkout=success',
      'https://app.matrix-os.com',
    );
    const dom = new JSDOM(html, {
      url: 'https://app.matrix-os.com/?checkout=success',
      runScripts: 'dangerously',
      beforeParse(window) {
        window.sessionStorage.setItem('matrix.billing.checkoutAttemptAt', String(Date.now()));
        Object.assign(window, {
          AbortSignal,
          Response,
          Clerk: {
            load: async () => undefined,
            user: {
              fullName: 'Test User',
              username: 'test-user',
              primaryEmailAddress: { emailAddress: 'test@example.com' },
            },
            session: { getToken: async () => 'clerk-token' },
            signOut: async () => undefined,
          },
          fetch: async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            requests.push({ url, init });
            if (url === '/api/auth/app-session') {
              appSessionAttempts += 1;
              return appSessionAttempts === 1
                ? new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
                : Response.json({ redirectTo: '/' });
            }
            return new Response('{}', { status: 503 });
          },
        });
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
          nativeSetTimeout(handler, timeout === 4_000 ? 0 : timeout, ...args)) as typeof window.setTimeout;
      },
    });
    openDoms.push(dom);

    await waitForCondition(() => appSessionAttempts === 2);
    expect(dom.window.document.querySelector('.default-installs-state')).toBeNull();
    const authText = dom.window.document.getElementById('auth')?.textContent ?? '';
    expect(authText).toContain('Finishing your Matrix computer');
    expect(authText).not.toContain('Build VPS');
    expect(requests.filter((request) => request.url === '/api/auth/provision-runtime')).toHaveLength(0);
    expect(requests.filter((request) => request.url === '/api/auth/app-session')).toHaveLength(2);
  });

  it('keeps a device return passive when checkout storage is unavailable', async () => {
    const requests: string[] = [];
    let appSessionAttempts = 0;
    const devicePath = '/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK';
    const html = getAuthPage(
      'pk_test_matrix',
      'sign-up',
      'test-nonce',
      devicePath,
      'https://app.matrix-os.com',
    );
    const dom = new JSDOM(html, {
      url: `https://app.matrix-os.com${devicePath}`,
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.assign(window, {
          AbortSignal,
          Response,
          Clerk: {
            load: async () => undefined,
            user: {
              fullName: 'Test User',
              username: 'test-user',
              primaryEmailAddress: { emailAddress: 'test@example.com' },
            },
            session: { getToken: async () => 'clerk-token' },
            signOut: async () => undefined,
          },
          fetch: async (input: string | URL | Request) => {
            const url = String(input);
            requests.push(url);
            if (url === '/api/auth/app-session') {
              appSessionAttempts += 1;
              return appSessionAttempts === 1
                ? Response.json({ code: 'no_runtime' }, { status: 404 })
                : Response.json({ redirectTo: '/' });
            }
            return Response.json({}, { status: 503 });
          },
        });
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
          nativeSetTimeout(handler, timeout === 4_000 ? 0 : timeout, ...args)) as typeof window.setTimeout;
      },
    });
    openDoms.push(dom);

    await waitForCondition(() => appSessionAttempts === 2);
    expect(requests.filter((url) => url === '/api/auth/provision-runtime')).toHaveLength(0);
    expect(dom.window.document.querySelector('.default-installs-state')).toBeNull();
    expect(dom.window.document.getElementById('auth')?.textContent).toContain('Finishing your Matrix computer');
  });

  it('treats accepted legacy provisioning as progress until app-session is ready', async () => {
    const requests: string[] = [];
    let appSessionAttempts = 0;
    const html = getAuthPage(
      'pk_test_matrix',
      'sign-up',
      'test-nonce',
      '/',
      'https://app.matrix-os.com',
    );
    const dom = new JSDOM(html, {
      url: 'https://app.matrix-os.com/',
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.assign(window, {
          AbortSignal,
          Response,
          Clerk: {
            load: async () => undefined,
            user: {
              fullName: 'Test User',
              username: 'test-user',
              primaryEmailAddress: { emailAddress: 'test@example.com' },
            },
            session: { getToken: async () => 'clerk-token' },
            signOut: async () => undefined,
          },
          fetch: async (input: string | URL | Request) => {
            const url = String(input);
            requests.push(url);
            if (url === '/api/auth/app-session') {
              appSessionAttempts += 1;
              return appSessionAttempts < 3
                ? Response.json({ code: 'no_runtime' }, { status: 404 })
                : Response.json({ redirectTo: '/' });
            }
            if (url === '/api/auth/provision-runtime') {
              return Response.json({ status: 'provisioning' }, { status: 202 });
            }
            return Response.json({}, { status: 503 });
          },
        });
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
          nativeSetTimeout(handler, timeout === 4_000 ? 0 : timeout, ...args)) as typeof window.setTimeout;
      },
    });
    openDoms.push(dom);

    await waitForCondition(() => Boolean(dom.window.document.querySelector('.default-installs-state')));
    const buildButton = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Build VPS');
    if (!buildButton) throw new Error('Missing Build VPS button');
    buildButton.click();

    await waitForCondition(() => appSessionAttempts === 3);
    expect(requests.filter((url) => url === '/api/auth/provision-runtime')).toHaveLength(1);
    expect(dom.window.document.querySelector('.default-installs-state')).toBeNull();
    const authText = dom.window.document.getElementById('auth')?.textContent ?? '';
    expect(authText).toContain('Finishing your Matrix computer');
    expect(authText).not.toContain('Matrix could not start building');
  });
});

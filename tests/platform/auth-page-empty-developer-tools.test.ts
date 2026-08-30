import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthPage } from '../../packages/platform/src/auth-pages.js';

const TOOL_LABELS = ['Codex', 'Claude Code', 'OpenCode', 'Pi'] as const;

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for inline auth fallback state');
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('inline auth fallback developer tool selection', () => {
  const openDoms: JSDOM[] = [];

  afterEach(() => {
    for (const dom of openDoms.splice(0)) dom.window.close();
    vi.restoreAllMocks();
  });

  it('keeps an empty snapshot through billing delay, 202 provisioning, and app-session exchange', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    let provisionAttempts = 0;
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
            if (url === '/api/auth/provision-runtime') {
              provisionAttempts += 1;
              return new Response('{}', {
                status: provisionAttempts === 1 ? 402 : 202,
                headers: { 'content-type': 'application/json' },
              });
            }
            return new Response('{}', { status: 503 });
          },
        });
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
          nativeSetTimeout(handler, timeout === 8_000 ? 0 : timeout, ...args)) as typeof window.setTimeout;
      },
    });
    openDoms.push(dom);

    await waitForCondition(() => Boolean(dom.window.document.querySelector('.default-installs-state')));
    for (const label of TOOL_LABELS) {
      const input = Array.from(dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        .find((candidate) => candidate.getAttribute('aria-label') === label);
      if (!input) throw new Error(`Missing ${label} checkbox`);
      input.checked = false;
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }

    const buildButton = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Build VPS');
    if (!buildButton) throw new Error('Missing Build VPS button');
    expect(buildButton.disabled).toBe(false);
    buildButton.click();

    await waitForCondition(() => provisionAttempts === 2 && appSessionAttempts === 2);
    const provisionRequests = requests.filter((request) => request.url === '/api/auth/provision-runtime');
    expect(provisionRequests).toHaveLength(2);
    expect(provisionRequests.map((request) => requestBody(request.init).developerTools)).toEqual([[], []]);
    expect(requests.filter((request) => request.url === '/api/auth/app-session')).toHaveLength(2);
  });
});

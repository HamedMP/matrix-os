import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { DEFAULT_COMPUTE_CAP_CONFIG, monthStartUtc, nextMonthStartUtc } from '../../packages/platform/src/free-tier/compute-meter.js';
import { createApp } from '../../packages/platform/src/main.js';
import { shutdownPlatformApp } from '../../packages/platform/src/shutdown-platform-app.js';
import { renderComputeCapPage } from '../../packages/platform/src/substrates/compute-cap-page.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import type { ContainerProvider } from '../../packages/platform/src/substrates/container-provider.js';
import { createContainerSubstrate } from '../../packages/platform/src/substrates/container-substrate.js';
import { createSubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import { createVpsSubstrate } from '../../packages/platform/src/substrates/vps-substrate.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

/**
 * At the monthly compute cap a browser navigation gets a self-contained
 * platform page: fixed copy from the shared limit screens, the reset date,
 * and an owner-only Export my data button that waits out the export wake.
 */

const OWNER = 'user_cappage';
const OWNER_SESSION = { host: 'app.matrix-os.com', authorization: `Bearer ${OWNER}`, 'sec-fetch-mode': 'navigate' };
const RESETS_AT = '2026-12-01T00:00:00.000Z';
const TITLE = "This month's computer time is used up";
const FAILURE_COPY = {
  in_progress: 'An export is already running. Try again when it finishes.',
  too_large: 'Your data is too large to export in one file. Contact support.',
  unavailable: 'Export is unavailable right now. Try again in a moment.',
  failed: 'Your data could not be exported. Try again.',
};

function nonceOf(csp: string | null, kind: 'script-src' | 'style-src'): string {
  const match = new RegExp(`${kind} 'nonce-([A-Za-z0-9_-]+)'`).exec(csp ?? '');
  expect(match, `${kind} in ${csp}`).not.toBeNull();
  return match![1]!;
}

describe('the compute cap page served by the platform', () => {
  let db: PlatformDB;
  let lifecycle: ReturnType<typeof createContainerLifecycleService>;
  let platform: ReturnType<typeof createApp>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('runtime', { status: 200 }));
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'cappage', status: 'stopped', imageVersion: null,
      provisionedAt: new Date().toISOString(), substrate: 'container',
    });
    await db.executor.insertInto('runtime_compute_usage').values({
      clerk_user_id: OWNER, month_start: monthStartUtc(new Date()).toISOString().slice(0, 10),
      billed_ms: DEFAULT_COMPUTE_CAP_CONFIG.capMs, export_ms: 0, export_wakes: 0,
    }).execute();
    const provider: ContainerProvider = {
      run: vi.fn(async () => { throw new Error('no start at the cap'); }), suspend: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined), terminate: vi.fn(async () => undefined), describe: vi.fn(async () => null),
      list: vi.fn(async () => []), mintEndpointCredential: vi.fn(async () => { throw new Error('no credential at the cap'); }),
    };
    lifecycle = createContainerLifecycleService({ db, provider, buildBootPayload: async () => '{}', computeCap: DEFAULT_COMPUTE_CAP_CONFIG });
    const container = createContainerSubstrate({
      lifecycle, provider, endpointHostSuffix: '.on.aws', loadMachine: (machineId) => getUserMachine(db, machineId),
    });
    platform = createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123', env: {},
      clerkAuth: createClerkAuth({ verifyToken: async (token) => ({ sub: token }) }),
      substrateRegistry: createSubstrateRegistry([createVpsSubstrate({ loadMachine: async () => undefined }), container]),
    });
  });

  afterEach(async () => {
    await lifecycle.shutdown();
    await shutdownPlatformApp(platform);
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  it('answers a navigation with fixed copy, the reset date, export, plans, a nonce CSP and no-store', async () => {
    const response = await platform.request('/vm/cappage/', { headers: OWNER_SESSION });
    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const csp = response.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await response.text();
    const nonce = nonceOf(csp, 'script-src');
    expect(nonceOf(csp, 'style-src')).toBe(nonce);
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain(`<h1 id="title">${TITLE}</h1>`);
    expect(html).toContain(`<time datetime="${nextMonthStartUtc(new Date()).toISOString()}">`);
    expect(html).toContain('data-export-path="/vm/cappage/api/system/export"');
    expect(html).toContain('>Export my data<');
    expect(html).toContain('<a class="secondary" href="/?plans=1">See paid plans</a>');
    expect(html).not.toMatch(/<link|\ssrc=|http-equiv="refresh"/);
  });

  it('points a session-routed page at the session-routed export path, with a fresh nonce each time', async () => {
    const first = await platform.request('/', { headers: OWNER_SESSION });
    const second = await platform.request('/', { headers: OWNER_SESSION });
    expect(first.status).toBe(429);
    expect(await first.text()).toContain('data-export-path="/api/system/export"');
    expect(nonceOf(first.headers.get('content-security-policy'), 'script-src'))
      .not.toBe(nonceOf(second.headers.get('content-security-policy'), 'script-src'));
  });
});

describe('rendering the compute cap page', () => {
  it('escapes every interpolated value', () => {
    const html = renderComputeCapPage({
      resetsAt: '"><script>alert(1)</script>', exportPath: '/vm/x"><img>/api/system/export', nonce: 'n0nce',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('"><img>');
    expect(html).toContain('Your computer starts again when your monthly time resets.');
  });

  it('shows the export button only to an owner', () => {
    const html = renderComputeCapPage({ resetsAt: RESETS_AT, exportPath: null, nonce: 'n0nce' });
    expect(html).not.toContain('Export my data');
    expect(html).not.toContain('data-export-path');
    expect(html).toContain('See paid plans');
  });
});

interface FakeResponse { status: number; headers?: Record<string, string>; body?: string }

describe('the compute cap page in a browser', () => {
  const doms: JSDOM[] = [];
  afterEach(() => { for (const dom of doms.splice(0)) dom.window.close(); });

  function open(responses: FakeResponse[] | ((call: number) => FakeResponse)) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const delays: number[] = [];
    const downloads: string[] = [];
    let elapsed = 0;
    const html = renderComputeCapPage({ resetsAt: RESETS_AT, exportPath: '/vm/cappage/api/system/export', nonce: 'n0nce' });
    const dom = new JSDOM(html, {
      url: 'https://app.matrix-os.com/vm/cappage/',
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.assign(window, {
          AbortSignal,
          fetch: async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            const next = typeof responses === 'function' ? responses(calls.length) : responses[calls.length - 1]!;
            return {
              status: next.status, ok: next.status >= 200 && next.status < 300,
              headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null },
              blob: async () => new window.Blob([next.body ?? '']),
            };
          },
          setTimeout: (callback: () => void, ms: number) => { delays.push(ms); elapsed += ms; queueMicrotask(callback); return 0; },
        });
        // The page's clock moves only with its own waits.
        const start = Date.parse('2026-11-14T03:00:00.000Z');
        window.Date.now = () => start + elapsed;
        window.URL.createObjectURL = () => 'blob:https://app.matrix-os.com/export';
        window.URL.revokeObjectURL = () => undefined;
        window.HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { downloads.push(this.download); };
      },
    });
    doms.push(dom);
    const document = dom.window.document;
    const status = () => document.getElementById('status')!.textContent;
    const button = document.getElementById('export') as HTMLButtonElement;
    const settle = () => vi.waitFor(() => expect(button.disabled).toBe(false));
    return { document, calls, delays, downloads, status, button, settle };
  }

  it('formats the reset date in the browser locale', () => {
    const { document } = open([]);
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(RESETS_AT));
    expect(document.querySelector('time')!.textContent).toBe(expected);
  });

  it('downloads the export with the export header, waiting out the wake on Retry-After', async () => {
    const page = open([
      { status: 503, headers: { 'retry-after': '3' } },
      { status: 503, headers: { 'retry-after': '3' } },
      { status: 200, headers: { 'content-disposition': 'attachment; filename="matrix-export-20261114T031500Z.tar.gz"' }, body: 'tar' },
    ]);
    page.button.click();
    expect(page.status()).toBe('Preparing your export');
    await page.settle();
    expect(page.calls).toHaveLength(3);
    for (const call of page.calls) {
      expect(call.url).toBe('/vm/cappage/api/system/export');
      expect(call.init.credentials).toBe('include');
      expect((call.init.headers as Record<string, string>)['X-Matrix-Export']).toBe('1');
    }
    expect(page.delays.filter((ms) => ms > 0)).toEqual([3_000, 3_000]);
    expect(page.downloads).toEqual(['matrix-export-20261114T031500Z.tar.gz']);
    expect(page.status()).toBe('');
  });

  it('keeps waiting through a slow start that takes most of the 90 second window', async () => {
    const page = open((call) => call <= 25
      ? { status: 503, headers: { 'retry-after': '3' } }
      : { status: 200, headers: { 'content-disposition': 'attachment; filename="matrix-export-20261114T031500Z.tar.gz"' }, body: 'tar' });
    page.button.click();
    await page.settle();
    expect(page.calls).toHaveLength(26);
    expect(page.downloads).toEqual(['matrix-export-20261114T031500Z.tar.gz']);
  });

  it('gives up once the start window and its margin have passed, and shows the unavailable copy', async () => {
    const page = open(() => ({ status: 503, headers: { 'retry-after': '3' } }));
    page.button.click();
    await page.settle();
    // 120 s of 3 s waits, then the first answer past the deadline is final.
    expect(page.calls).toHaveLength(41);
    expect(page.status()).toBe(FAILURE_COPY.unavailable);
    expect(page.downloads).toEqual([]);
  });

  it.each([
    [409, FAILURE_COPY.in_progress],
    [413, FAILURE_COPY.too_large],
    [503, FAILURE_COPY.unavailable],
    [429, FAILURE_COPY.failed],
    [500, FAILURE_COPY.failed],
  ])('shows the fixed copy for %i', async (code, copy) => {
    const page = open([{ status: code }]);
    page.button.click();
    await page.settle();
    expect(page.calls).toHaveLength(1);
    expect(page.status()).toBe(copy);
  });

  it('shows the failed copy when the request cannot be made', async () => {
    const page = open(() => { throw new TypeError('network'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    page.button.click();
    await page.settle();
    expect(page.status()).toBe(FAILURE_COPY.failed);
    warn.mockRestore();
  });
});

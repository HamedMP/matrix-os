import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { listAccountExportFiles } from '../../packages/platform/src/account-deletion/export.js';
import { createAccountDeletionRoutes } from '../../packages/platform/src/account-deletion/routes.js';
import { getAccountDeletionPage } from '../../packages/platform/src/account-deletion/page.js';
import type { AccountDeletionService } from '../../packages/platform/src/account-deletion/types.js';

interface Element {
  hidden: boolean; disabled: boolean; checked: boolean; textContent: string; href: string; rel: string;
  children: Element[]; listeners: Record<string, () => Promise<void>>;
  addEventListener(event: string, callback: () => Promise<void>): void;
  replaceChildren(): void; appendChild(child: Element): void;
}

function pageHarness(fetch: (path: string, init: RequestInit) => Promise<Response>) {
  function makeElement(): Element {
    return { hidden: false, disabled: false, checked: false, textContent: '', href: '', rel: '', children: [], listeners: {},
      addEventListener(event, callback) { this.listeners[event] = callback; },
      replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  }
  // Fixed, small DOM fixture; no production or customer browser is involved.
  const ids = ['account','signin','status','error','delete','cancel','export','platform-export','more','ack','confirm','downloads','export-note','clerk-script','records-more','records-note','records-again','records-confirm'];
  const elements = Object.fromEntries(ids.map(id => [id, makeElement()]));
  elements.account.hidden = true;
  const html = getAccountDeletionPage({ nonce: 'fixture', publishableKey: 'pk_fixture' });
  const script = html.match(/<script nonce="fixture">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Account page script missing');
  runInNewContext(script, {
    document: { getElementById: (id: string) => elements[id], createElement: makeElement },
    window: { Clerk: { session: { getToken: async () => 'fixture-owner' }, load: async () => {} } },
    fetch, AbortSignal, URL, Blob, SyntaxError, console,
    location: { origin: 'https://app.matrix-os.com', assign: vi.fn() },
  });
  return elements;
}

describe('ENG-287 continuation safety', () => {
  it('keeps downloaded rows and retries the same failed continuation without scheduling deletion', async () => {
    const service: AccountDeletionService = {
      get: vi.fn(async () => ({ status: 'none' as const, completesBy: null, billingStopped: false })),
      schedule: vi.fn(), cancel: vi.fn(), reconcile: vi.fn(), isBlocked: vi.fn(),
    };
    let failed = false;
    const store = {
      listObjects: vi.fn(async (prefix: string, cursor?: string) => {
        if (cursor === 'second' && !failed) { failed = true; throw new Error('PRIVATE_STORAGE_FAILURE'); }
        return { keys: [prefix + (cursor ? 'second.txt' : 'first.txt')], nextCursor: cursor ? null : 'second' };
      }),
      getPresignedGetUrl: vi.fn(async (key: string) => 'https://storage.example.test/' + key),
      deleteObject: vi.fn(), abortOwnerMultipartUploads: vi.fn(),
    };
    const app = createAccountDeletionRoutes({ service, verify: async token => token === 'fixture-owner' ? 'user_export' : null,
      exportData: async (owner, cursor) => {
        const page = await listAccountExportFiles(store, owner, 'matrixos-sync', cursor);
        return { downloads: page.files.map(file => ({ name: file.path, url: file.downloadUrl })),
          migrationUrl: '/runtime', nextCursor: page.nextCursor, instructions: [page.migrationInstructions] };
      } });
    const fetch = vi.fn(async (path: string, init: RequestInit) => app.request(path, init));
    const elements = pageHarness(fetch);
    await vi.waitFor(() => expect(elements.account.hidden).toBe(false));
    await elements.export.listeners.click();
    expect(elements.downloads.children.map(child => child.textContent)).toEqual(['first.txt']);
    await elements.more.listeners.click();
    expect(elements.error.textContent).toContain('could not be completed');
    expect(elements.error.textContent).not.toContain('PRIVATE_');
    expect(elements.downloads.children.map(child => child.textContent)).toEqual(['first.txt']);
    expect(elements.more.hidden).toBe(false); expect(elements.more.disabled).toBe(false);
    const failedPath = fetch.mock.calls.at(-1)![0];
    await elements.more.listeners.click();
    expect(fetch.mock.calls.at(-1)![0]).toBe(failedPath);
    expect(elements.downloads.children.map(child => child.textContent)).toEqual(['first.txt', 'second.txt']);
    expect(service.schedule).not.toHaveBeenCalled(); expect(service.cancel).not.toHaveBeenCalled();
    expect(store.deleteObject).not.toHaveBeenCalled(); expect(store.abortOwnerMultipartUploads).not.toHaveBeenCalled();
  });
});

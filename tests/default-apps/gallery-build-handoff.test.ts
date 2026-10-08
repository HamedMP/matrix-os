import { describe, expect, it, vi } from 'vitest';
import { requestAppBuild } from '../../home/apps/app-gallery/src/build-handoff';

describe('Gallery build handoff', () => {
  it('passes the bounded app request to the authenticated Matrix bridge', async () => {
    const generate = vi.fn();
    await requestAppBuild({ generate }, '  Compare my subscriptions  ');
    expect(generate).toHaveBeenCalledExactlyOnceWith('[BUILD] Build an app for my Matrix computer: Compare my subscriptions. Use my connected tools only after I choose the accounts and approve imports. Make it work in Web Desktop, Web Canvas, Electron Desktop, Web Mobile and Native Mobile.');
  });
  it('rejects empty or oversized requests without dispatching', async () => {
    const generate = vi.fn();
    await expect(requestAppBuild({ generate }, ' ')).rejects.toThrow();
    await expect(requestAppBuild({ generate }, 'a'.repeat(2001))).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
  it('reports unavailable and failed bridges instead of implying an app was built', async () => {
    await expect(requestAppBuild({}, 'Weekly plan')).rejects.toThrow();
    await expect(requestAppBuild({ generate: async () => { throw new Error('unavailable'); } }, 'Weekly plan')).rejects.toThrow();
  });
});

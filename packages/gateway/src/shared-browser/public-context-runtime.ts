import { SharedBrowserError } from './broker.js';
import { connectBrowserCdp, type BrowserCdpClient } from './cdp-client.js';
import { startPublicBrowserEgress } from './public-egress.js';

type Owner = Pick<BrowserCdpClient, 'available' | 'request' | 'close'>;
type Egress = Awaited<ReturnType<typeof startPublicBrowserEgress>>;
type Context = { id: string; owner: Owner; egress: Egress };

/** The browser-root context owner stays open across Chat detach/reconnect.
 * Chrome disposes only this context if the owning gateway exits or disconnects. */
export function createPublicBrowserContextRuntime(options: {
  connectOwner?: () => Promise<Owner>;
  startEgress?: () => Promise<Egress>;
} = {}) {
  let current: Context | undefined;
  let creating: Promise<Context> | undefined;
  let closing: Promise<void> | undefined;
  const unavailable = () => new SharedBrowserError('browser_unavailable');

  async function open(): Promise<Context> {
    const previous = current;
    current = undefined;
    let egress: Egress | undefined;
    let owner: Owner | undefined;
    try {
      if (previous) {
        try { await previous.owner.close(); } finally { await previous.egress.close(); }
      }
      egress = await (options.startEgress ?? startPublicBrowserEgress)();
      owner = await (options.connectOwner ?? connectBrowserCdp)();
      const result = await owner.request('Target.createBrowserContext', {
        disposeOnDetach: true,
        proxyServer: `http://127.0.0.1:${egress.port}`,
        proxyBypassList: '<-loopback>',
      });
      const id = result.browserContextId;
      if (closing || !owner.available || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw unavailable();
      await owner.request('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: id, eventsEnabled: false });
      if (closing || !owner.available) throw unavailable();
      return current = { id, owner, egress };
    } catch (error) {
      if (!(error instanceof SharedBrowserError)) console.warn('[shared-browser] Public context could not start');
      await Promise.allSettled([owner?.close(), egress?.close()]);
      throw unavailable();
    }
  }

  return {
    async create(missingContextId?: string): Promise<string> {
      if (closing) throw unavailable();
      if (current?.owner.available && current.id !== missingContextId) return current.id;
      creating ??= open().finally(() => { creating = undefined; });
      return (await creating).id;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closing = (async () => {
        if (creating) await creating.catch((error: unknown) => {
          console.warn('[shared-browser] Public context closed before startup',
            error instanceof SharedBrowserError ? error.code : 'operation_failed');
        }); // open owns cleanup.
        const context = current;
        current = undefined;
        if (!context) return;
        try { await context.owner.close(); } finally { await context.egress.close(); }
      })();
      return closing;
    },
  };
}

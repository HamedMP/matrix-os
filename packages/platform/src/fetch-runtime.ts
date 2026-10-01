import { Agent, fetch as undiciFetch, FormData as UndiciFormData, setGlobalDispatcher } from 'undici';

/**
 * Node 24 bundles undici 7, whose HTTP/1 parser kills the whole process with an
 * uncatchable `assert(!this.paused)` when a non-keep-alive upstream sends FIN while
 * the response body is paused on backpressure (nodejs/undici#5360). The platform's
 * proxies send `connection: close` and stream bodies to browsers that stall or
 * navigate away, so this took the platform (and every shell behind it) down.
 *
 * The fix (nodejs/undici#5389, #5474) shipped only in undici 8, so the platform
 * process runs undici 8's fetch instead of Node's bundled copy. undici 8 keeps its
 * global dispatcher under a new symbol, so swapping the dispatcher alone would not
 * reach Node's fetch; the fetch function itself has to be replaced.
 *
 * Behaviour pinned to match the bundled client: HTTP/2 stays off (undici 8 turns
 * `allowH2` on by default, and `connection: close` is illegal on h2).
 *
 * `FormData` is replaced together with `fetch`: undici brand-checks request bodies,
 * so a `FormData` built by Node's bundled copy is not recognised by undici 8's
 * fetch and gets serialised as the string "[object FormData]" with `text/plain`
 * (nodejs/undici#4285; undici docs "Keep fetch and FormData together"). The speech
 * adapter posts multipart uploads this way. `Request`/`Response` are deliberately
 * left alone: @hono/node-server owns those globals.
 */
export const FIXED_UNDICI_MAJOR = 8;

export type FetchRuntimeTarget = { fetch: typeof fetch; FormData: typeof FormData };

export function bundledUndiciNeedsReplacement(bundledVersion: string | undefined = process.versions.undici): boolean {
  const major = Number.parseInt(bundledVersion ?? '0', 10);
  return !Number.isFinite(major) || major < FIXED_UNDICI_MAJOR;
}

export function installPlatformFetchRuntime(
  target: FetchRuntimeTarget = globalThis,
  bundledVersion: string | undefined = process.versions.undici,
): boolean {
  if (!bundledUndiciNeedsReplacement(bundledVersion)) return false;
  setGlobalDispatcher(new Agent({ allowH2: false }));
  target.fetch = undiciFetch as unknown as typeof fetch;
  target.FormData = UndiciFormData as unknown as typeof FormData;
  return true;
}

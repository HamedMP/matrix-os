import { BOKIO_ACTIONS, BOKIO_ACTION_SPECS, BokioUuid } from "@matrix-os/contracts/bokio-integration";
export { BOKIO_ACTIONS, BokioUuid } from "@matrix-os/contracts/bokio-integration";

export const BOKIO_PRESET = { id: "bokio", name: "Bokio", url: "https://api.bokio.se/v1" } as const;
export const BOKIO_READ_SCOPES = ["company-information:read", "customers:read", "invoices:read", "journal-entries:read", "uploads:read"] as const;
export class BokioIntegrationError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "upstream" | "conflict" | "action_required") {
    super("Connection action unavailable"); this.name = "BokioIntegrationError";
  }
}
export function planBokioRead(actionId: string, params: unknown, companyId: string): { url: string } {
  try {
    if (!Object.hasOwn(BOKIO_ACTION_SPECS, actionId)) throw new BokioIntegrationError("invalid");
    const spec = BOKIO_ACTION_SPECS[actionId as keyof typeof BOKIO_ACTION_SPECS];
    const input = spec.schema.parse(params ?? {}) as Record<string, unknown>;
    const url = new URL(`${BOKIO_PRESET.url}/companies/${BokioUuid.parse(companyId)}/${spec.path}${spec.id ? `/${BokioUuid.parse(input[spec.id])}` : ""}`);
    if (Object.hasOwn(BOKIO_ACTIONS[actionId].params, "page")) { url.searchParams.set("page", String(input.page ?? 1)); url.searchParams.set("pageSize", String(input.pageSize ?? 25)); }
    return { url: url.href };
  } catch (error: unknown) {
    if (error instanceof BokioIntegrationError) throw error;
    throw new BokioIntegrationError("invalid");
  }
}

function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  void body?.cancel().catch((error: unknown) => console.warn("[bokio] response cancellation failed", { errorName: error instanceof Error ? error.name : "UnknownError" }));
}
async function deadline<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), new Promise<never>((_resolve, reject) => {
      abort = () => reject(new BokioIntegrationError("upstream")); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
/** Fixed Bokio host, no redirects, bounded bytes/chunks and one total deadline. */
export async function requestBokio(input: { url: string; method: "GET" | "POST" | "DELETE"; headers: Record<string, string>; body?: string; maxBytes: number; fetcher?: typeof fetch }): Promise<unknown> {
  const url = new URL(input.url);
  if (url.origin !== "https://api.bokio.se" || !url.pathname.startsWith("/v1/") || url.username || url.password || url.hash) throw new BokioIntegrationError("invalid");
  const signal = AbortSignal.timeout(10_000);
  let response: Response | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await deadline(() => (input.fetcher ?? fetch)(url.href, { method: input.method, headers: { Accept: "application/json", ...input.headers }, ...(input.body !== undefined ? { body: input.body } : {}), redirect: "error", signal }), signal);
    // A lost successful revoke can make an explicit retry find no connection.
    // Accept only this exact fixed-host DELETE resource, never missing read data.
    if (response.status === 404 && input.method === "DELETE" && !url.search
      && url.pathname.startsWith("/v1/connections/") && BokioUuid.safeParse(url.pathname.slice("/v1/connections/".length)).success) {
      cancel(response.body); return undefined;
    }
    const length = response.headers.get("content-length");
    if (!response.ok || (length !== null && (!/^\d+$/.test(length) || Number(length) > input.maxBytes))) throw new BokioIntegrationError("upstream");
    if (response.status === 204) { cancel(response.body); return undefined; }
    if (!response.body) throw new BokioIntegrationError("upstream");
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const next = await deadline(() => reader!.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > input.maxBytes || chunks.length >= 4096) throw new BokioIntegrationError("upstream");
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes))) as unknown;
  } catch (error: unknown) {
    cancel(reader ?? response?.body ?? null);
    console.warn("[bokio] bounded request failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    throw new BokioIntegrationError("upstream");
  } finally { reader?.releaseLock(); }
}

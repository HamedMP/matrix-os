import {
  BrowserSpeechClientError,
  createBrowserSpeechClient as createSharedBrowserSpeechClient,
  type BrowserSpeechClient,
} from "@matrix-os/ui";
import { getGatewayUrl } from "./gateway.js";

export { BrowserSpeechClientError };
export type { BrowserSpeechClient };

export function createBrowserSpeechClient(options: {
  baseUrl?: string;
  fetcher?: typeof fetch;
  makeTimeoutSignal?: (ms: number) => AbortSignal;
} = {}): BrowserSpeechClient {
  return createSharedBrowserSpeechClient({
    baseUrl: options.baseUrl ?? getGatewayUrl(),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.makeTimeoutSignal ? { makeTimeoutSignal: options.makeTimeoutSignal } : {}),
  });
}

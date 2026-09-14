import {
  createHermesStdioClient,
  HermesGatewayReadyTimeout,
  type HermesStdioClient,
} from "./hermes-stdio-client.js";
import { retryUnadmittedStartup, RetryableProviderStartupTimeout } from "../coding-agents/provider-startup-retry.mjs";

export class HermesStartupCleanupUnconfirmed extends Error {
  readonly name = "HermesStartupCleanupUnconfirmed";
  constructor() { super("Hermes startup cleanup requires reconciliation"); }
}

/** Only gateway.ready is retried. No session or prompt RPC is sent here. */
export async function startHermesGateway(options: {
  client: Parameters<typeof createHermesStdioClient>[0];
  signal: AbortSignal;
  onRetry: (progress: { retry: number; maxRetries: 5; label: string }) => Promise<void>;
  onCleanupUnconfirmed(): void;
  onCleanupConfirmed(): void;
}): Promise<HermesStdioClient> {
  return retryUnadmittedStartup({
    signal: options.signal,
    onRetry: options.onRetry,
    async attempt(signal) {
      signal.throwIfAborted();
      let admittedToCaller = false;
      const client = createHermesStdioClient({ ...options.client,
        onFailure(error) {
          // A retired attempt must not settle the logical Run's completion.
          if (admittedToCaller) options.client.onFailure(error);
        },
      });
      let rejectAbort!: (error: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const abort = () => rejectAbort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) abort();
        await Promise.race([client.ready(), aborted]);
        signal.throwIfAborted();
        admittedToCaller = true;
        return client;
      } catch (error) {
        if (!await client.close()) {
          options.onCleanupUnconfirmed();
          // Keep the existing adapter iterator and orchestrator capacity owned
          // until actual exit. Abort/kill/deadline never grants retry permission.
          await client.whenExited();
          options.onCleanupConfirmed();
          throw new HermesStartupCleanupUnconfirmed();
        }
        signal.throwIfAborted();
        if (error instanceof HermesGatewayReadyTimeout) throw new RetryableProviderStartupTimeout();
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  });
}

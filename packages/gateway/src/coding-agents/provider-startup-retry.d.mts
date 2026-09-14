export class RetryableProviderStartupTimeout extends Error {
  constructor();
}
export function retryUnadmittedStartup<T>(options: {
  signal: AbortSignal;
  attempt: (signal: AbortSignal) => Promise<T>;
  onRetry: (event: { retry: number; maxRetries: 5; label: string }) => Promise<void>;
}): Promise<T>;

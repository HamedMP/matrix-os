// Private failure proof, never derived from a public error string. Construct
// only after a startup timeout before prompt admission AND confirmed process exit.
export class RetryableProviderStartupTimeout extends Error {
  constructor() {
    super("Provider startup timed out before admission; process stopped");
    this.name = "RetryableProviderStartupTimeout";
  }
}

function backoff(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// attempt owns cancellation/cleanup of resources it creates, including a late
// success. This is the single retry budget: one initial attempt plus five retries.
export async function retryUnadmittedStartup({ signal, attempt, onRetry }) {
  for (let retry = 0; ; retry += 1) {
    signal.throwIfAborted();
    try {
      return await attempt(signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof RetryableProviderStartupTimeout) || retry >= 5) throw error;
      await onRetry({ retry: retry + 1, maxRetries: 5, label: `Reconnecting… ${retry + 1}/5` });
      await backoff(Math.min(250 * 2 ** retry, 4_000), signal);
    }
  }
}

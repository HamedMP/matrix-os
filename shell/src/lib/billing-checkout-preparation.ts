const PREPARATION_POLL_INTERVAL_MS = 1_500;
const MAX_PREPARATION_POLLS = 240;

type CheckoutPreparationBody = {
  status?: unknown;
  url?: unknown;
};

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForPreparedCheckout(options: {
  attemptId: string;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<{ url: string }> {
  const fetcher = options.fetcher ?? fetch;
  const wait = options.wait ?? waitForDelay;
  const statusUrl = `/billing/checkout/status?attemptId=${encodeURIComponent(options.attemptId)}`;
  for (let poll = 0; poll < MAX_PREPARATION_POLLS; poll += 1) {
    await wait(PREPARATION_POLL_INTERVAL_MS, options.signal);
    const response = await fetcher(statusUrl, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: options.signal,
    });
    const body = await response.json().catch(() => null) as CheckoutPreparationBody | null;
    if (response.ok && typeof body?.url === 'string' && body.url.length > 0) {
      return { url: body.url };
    }
    if (response.status !== 202 || body?.status !== 'preparing') {
      throw new Error('checkout_preparation_failed');
    }
  }
  throw new Error('checkout_preparation_timeout');
}

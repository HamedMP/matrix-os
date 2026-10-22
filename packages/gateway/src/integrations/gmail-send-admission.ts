/** Trusted request-scoped capability; never parse it from tool/HTTP JSON or cache its approval. */
export type BeforeGmailSend = (signal: AbortSignal) => Promise<void>;

export async function admitGmailSend(signal: AbortSignal, beforeSend?: BeforeGmailSend): Promise<void> {
  signal.throwIfAborted();
  if (beforeSend) await beforeSend(signal);
  // A guard may finish after cancellation, even if its dependencies ignore the signal.
  signal.throwIfAborted();
}

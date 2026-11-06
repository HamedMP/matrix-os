import { setTimeout as delay } from 'node:timers/promises';
import { PlanFailure, logPlanFailure } from './diagnostics';
import { retryableDeliveryFailure } from './poll-delivery';

/** Only the negotiated current reply is resent; inference/tool execution never is. */
export async function sendNativeStreamReply<T>(options: {
  enabled: boolean; signal: AbortSignal; current(): boolean; post(): Promise<T>;
}): Promise<T> {
  const verify = () => {
    options.signal.throwIfAborted();
    if (!options.current()) throw new PlanFailure('peer_reply', 'stale_source');
  };
  for (let attempt = 0; ; attempt++) {
    verify();
    try { const ack = await options.post(); verify(); return ack; }
    catch (error: unknown) {
      verify();
      if (!options.enabled || attempt !== 0 || !retryableDeliveryFailure(error, 'peer_reply')) throw error;
      logPlanFailure('peer_reply', error);
      await delay(100, undefined, { signal: options.signal });
      verify();
    }
  }
}

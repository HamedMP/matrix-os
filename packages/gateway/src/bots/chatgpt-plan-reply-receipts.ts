import { createHash } from 'node:crypto';
import { CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS } from '@matrix-os/contracts';
import { ChatGptPlanPeerError } from './chatgpt-plan-peer-error.js';

/** Session-owned transport receipts, never evidence of canonical run success. */
export function createPeerReplyReceipts(now: () => number) {
  const finals = new Map<string, { sequence: number; expires: number }>(); // <=32, FIFO + fixed TTL.
  const sweep = () => { for (const [id, entry] of finals) if (entry.expires <= now()) finals.delete(id); };
  return {
    remember(id: string, sequence: number) {
      sweep();
      if (finals.size >= 32) finals.delete(finals.keys().next().value!);
      finals.set(id, { sequence, expires: now() + CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS });
    },
    ended(id: string, sequence: number) { sweep(); return finals.get(id)?.sequence === sequence; },
    close() { finals.clear(); },
  };
}

/** One last chunk's digest/consumption ACK; no extra retained text or ACK waiters. */
export function createChunkReceipt() {
  let last: { sequence: number; digest: string; ack: Promise<void>; httpAttempts: number } | undefined;
  return (sequence: number, body: string, accept: () => Promise<void>, http: boolean) => {
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    if (last?.sequence === sequence) {
      if (last.digest !== digest) throw new ChatGptPlanPeerError('conflict');
      if (http && last.httpAttempts >= 2) throw new ChatGptPlanPeerError('unavailable');
      if (http) last.httpAttempts++;
      return last.ack;
    }
    const ack = accept(); // Existing sequencing/backpressure/Cancel remains authoritative.
    last = { sequence, digest, ack, httpAttempts: http ? 1 : 0 };
    return ack;
  };
}

import { z } from 'zod/v4';
import { NATIVE_GMAIL_ACCOUNT, NativeGmailRequestError, type createNativeGmailRequest } from './request.js';
import type { BeforeGmailSend } from '../gmail-send-admission.js';
const Input = z.strictObject({ externalUserId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
  accountId: z.string().regex(NATIVE_GMAIL_ACCOUNT), labelId: z.string().max(128).regex(/^Label_[A-Za-z0-9_-]{1,122}$/),
  expectedName: z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/).refine(s => s.trim().length > 0) });

/** One mutation attempt, fresh per-send admission and fixed native targets. Gmail
 * offers no atomic empty-only delete: concurrent external label changes remain
 * a provider race. Only absence readback establishes cleanup, never HTTP 2xx. */
export function createNativeUnusedLabelDelete(request: ReturnType<typeof createNativeGmailRequest>) {
  return async (raw: unknown, callerSignal?: AbortSignal, beforeSend?: BeforeGmailSend): Promise<unknown> => {
    const input = Input.parse(raw);
    const deadline = AbortSignal.timeout(10_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    const identity = { externalUserId: input.externalUserId, accountId: input.accountId };
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/labels/${input.labelId}`;
    const read = { ...identity, url: url + '?fields=id,name,type,messagesTotal,threadsTotal' };
    const metadata = await request(read, 'GET', 32 * 1024, signal, beforeSend);
    if (!z.object({ id: z.literal(input.labelId), name: z.literal(input.expectedName), type: z.literal('user'),
      messagesTotal: z.literal(0), threadsTotal: z.literal(0) }).safeParse(metadata).success) throw new NativeGmailRequestError();
    const result = await request({ ...identity, url }, 'DELETE', 1024, signal, beforeSend);
    if (!z.strictObject({}).safeParse(result).success) throw new NativeGmailRequestError();
    try { await request(read, 'GET', 32 * 1024, signal, beforeSend); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof NativeGmailRequestError && error.statusCode === 404) return { deleted: true, labelId: input.labelId };
      throw error;
    }
    throw new NativeGmailRequestError();
  };
}

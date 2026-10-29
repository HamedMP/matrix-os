import type { BeforeGmailSend } from "../gmail-send-admission.js";
import type { PipedreamConnectClient } from '../pipedream.js';
import { BoundedGmailReadSchema } from '../pipedream-bounded-get.js';
import { BoundedGmailLabelsSchema } from '../pipedream-bounded-labels.js';
import { createReadCoalescer, proxyReadKey } from '../read-coalescer.js';
import { createNativeGmailRequest, isNativeGmailAccount, type GmailTokenSource, type NativeGmailRequest } from './request.js';
import { assertMessageTextUnchanged, messageTextPreflightFields, messageTextShape, projectMessageText } from './message-text.js';
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Select by persisted native account identity, never service name or caller-controlled URL. */
export function createNativeGmailClient(options: { legacy: PipedreamConnectClient; oauth: GmailTokenSource; fetcher?: typeof fetch }): PipedreamConnectClient {
  const { legacy } = options;
  const request = createNativeGmailRequest(options);
  const coalesce = createReadCoalescer(128, 10_000);
  const get = (input: NativeGmailRequest, limit?: number, signal?: AbortSignal, beforeSend?: BeforeGmailSend) => signal || beforeSend ? request(input, 'GET', limit, signal, beforeSend)
    : coalesce(JSON.stringify([proxyReadKey(input), limit ?? 2 * 1024 * 1024]), () => request(input, 'GET', limit));
  const control = (beforeSend?: BeforeGmailSend, signal?: AbortSignal): [BeforeGmailSend?, AbortSignal?] =>
    signal ? [beforeSend, signal] : beforeSend ? [beforeSend] : [];
  return {
    ...legacy,
    boundedFinanceAction: async (input, signal) => {
      rejectNativeLegacyInput(input);
      if (!legacy.boundedFinanceAction) throw new Error('Integration unavailable');
      return legacy.boundedFinanceAction(input, signal);
    },
    boundedManagedAction: async (input, signal) => {
      rejectNativeLegacyInput(input);
      if (!legacy.boundedManagedAction) throw new Error('Integration unavailable');
      return legacy.boundedManagedAction(input, signal);
    },
    readDriveFile: async input => {
      rejectNativeLegacyInput(input);
      if (!legacy.readDriveFile) throw new Error('Integration unavailable');
      return legacy.readDriveFile(input);
    },
    proxyGet: (input, beforeSend, signal) => isNativeGmailAccount(input.accountId) ? get(input, undefined, signal, beforeSend) : legacy.proxyGet(input, ...control(beforeSend, signal)),
    proxyPost: (input, beforeSend, signal) => isNativeGmailAccount(input.accountId) ? request(input, 'POST', undefined, signal, beforeSend) : legacy.proxyPost(input, ...control(beforeSend, signal)),
    proxyPut: (input, beforeSend, signal) => isNativeGmailAccount(input.accountId) ? request(input, 'PUT', undefined, signal, beforeSend) : legacy.proxyPut(input, ...control(beforeSend, signal)),
    proxyPatch: (input, beforeSend, signal) => isNativeGmailAccount(input.accountId) ? request(input, 'PATCH', undefined, signal, beforeSend) : legacy.proxyPatch(input, ...control(beforeSend, signal)),
    proxyDelete: (input, beforeSend, signal) => isNativeGmailAccount(input.accountId) ? request(input, 'DELETE', undefined, signal, beforeSend) : legacy.proxyDelete(input, ...control(beforeSend, signal)),
    callAction: (input, beforeSend, signal) => isNativeGmailAccount(input.accountId) ? request(input, 'POST', undefined, signal, beforeSend) : legacy.callAction(input, ...control(beforeSend, signal)),
    boundedGmailGet: async (raw, signal, beforeSend) => {
      const input = BoundedGmailReadSchema.parse(raw);
      if (input.kind === 'message-text') {
        if (!isNativeGmailAccount(input.accountId)) throw new Error('Integration read unavailable');
        const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
        const target = new URL(`${BASE}/messages/${input.id}`);
        target.searchParams.set('format', 'full'); target.searchParams.set('fields', messageTextPreflightFields());
        const identity = { externalUserId: input.externalUserId, accountId: input.accountId };
        const metadata = await request({ ...identity, url: target.href }, 'GET', 64 * 1024, boundedSignal, beforeSend);
        messageTextShape(metadata, input.id, true);
        target.searchParams.set('fields', 'id,threadId,internalDate,snippet,payload(mimeType,filename,headers,body,parts)');
        const content = await request({ ...identity, url: target.href }, 'GET', 128 * 1024, boundedSignal, beforeSend);
        assertMessageTextUnchanged(metadata, content, input.id); boundedSignal.throwIfAborted();
        return projectMessageText(content);
      }
      if (!isNativeGmailAccount(input.accountId)) {
        if (!legacy.boundedGmailGet) throw new Error('Integration read unavailable');
        return legacy.boundedGmailGet(input, signal, ...(beforeSend ? [beforeSend] : []));
      }
      const target = new URL(`${BASE}/profile`); let limit = 32 * 1024;
      if (input.kind === 'threads') {
        target.pathname = '/gmail/v1/users/me/threads';
        target.searchParams.set('labelIds', 'INBOX'); target.searchParams.set('maxResults', '30');
        target.searchParams.set('fields', 'threads(id,snippet),nextPageToken');
        if (input.pageToken) target.searchParams.set('pageToken', input.pageToken);
      } else if (input.kind === 'thread-ids') {
        target.pathname = `/gmail/v1/users/me/threads/${input.id}`; limit = 64 * 1024;
        target.searchParams.set('format', 'full'); target.searchParams.set('fields', 'id,historyId,messages(id,internalDate)');
      } else if (input.kind === 'message') {
        target.pathname = `/gmail/v1/users/me/messages/${input.id}`; limit = 128 * 1024;
        target.searchParams.set('format', 'full'); target.searchParams.set('fields', 'id,threadId,internalDate,snippet,payload(mimeType,filename,headers,body,parts)');
      } else if (input.kind === 'attachment') {
        target.pathname = `/gmail/v1/users/me/messages/${input.id}/attachments/${input.attachmentId}`;
        limit = Math.ceil((1024 * 1024) / 3) * 4 + 1024;
      }
      return get({ externalUserId: input.externalUserId, accountId: input.accountId, url: target.href }, limit, signal, beforeSend);
    },
    boundedGmailLabels: async (raw, signal, beforeSend) => {
      const input = BoundedGmailLabelsSchema.parse(raw);
      if (!isNativeGmailAccount(input.accountId)) {
        if (!legacy.boundedGmailLabels) throw new Error('Mailbox labeling could not be confirmed');
        return legacy.boundedGmailLabels(input, signal, ...(beforeSend ? [beforeSend] : []));
      }
      const target = new URL(`${BASE}/labels`); let body: Record<string, unknown> | undefined;
      if (input.kind === 'labels') target.searchParams.set('fields', 'labels(id,name,type)');
      else if (input.kind === 'create-label') body = { name: input.name, labelListVisibility: 'labelShow', messageListVisibility: 'show' };
      else {
        target.pathname = `/gmail/v1/users/me/messages/${input.messageId}${input.kind === 'add-labels' ? '/modify' : ''}`;
        target.searchParams.set('fields', 'id,threadId,labelIds');
        if (input.kind === 'message-labels') target.searchParams.set('format', 'minimal');
        else body = { addLabelIds: input.labelIds };
      }
      const limit = input.kind === 'labels' ? 512 * 1024 : 32 * 1024;
      const identity = { externalUserId: input.externalUserId, accountId: input.accountId, url: target.href };
      return body ? request({ ...identity, body }, 'POST', limit, signal, beforeSend) : get(identity, limit, signal, beforeSend);
    },
  };
}

/** Other bounded transports must never receive a persisted native Gmail identity. */
function rejectNativeLegacyInput(input: unknown): void {
  if (typeof input === 'object' && input !== null && 'accountId' in input
    && typeof input.accountId === 'string' && isNativeGmailAccount(input.accountId)) throw new Error('Integration unavailable');
}

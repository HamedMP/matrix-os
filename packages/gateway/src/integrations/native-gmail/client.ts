import type { PipedreamConnectClient } from '../pipedream.js';
import { BoundedGmailReadSchema } from '../pipedream-bounded-get.js';
import { BoundedGmailLabelsSchema } from '../pipedream-bounded-labels.js';
import { createReadCoalescer, proxyReadKey } from '../read-coalescer.js';
import { createNativeGmailRequest, isNativeGmailAccount, type GmailTokenSource, type NativeGmailRequest } from './request.js';
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Select by persisted native account identity, never service name or caller-controlled URL. */
export function createNativeGmailClient(options: { legacy: PipedreamConnectClient; oauth: GmailTokenSource; fetcher?: typeof fetch }): PipedreamConnectClient {
  const { legacy } = options;
  const request = createNativeGmailRequest(options);
  const coalesce = createReadCoalescer(128, 10_000);
  const get = (input: NativeGmailRequest, limit?: number, signal?: AbortSignal) => signal ? request(input, 'GET', limit, signal)
    : coalesce(JSON.stringify([proxyReadKey(input), limit ?? 2 * 1024 * 1024]), () => request(input, 'GET', limit));
  return {
    ...legacy,
    proxyGet: input => isNativeGmailAccount(input.accountId) ? get(input) : legacy.proxyGet(input),
    proxyPost: input => isNativeGmailAccount(input.accountId) ? request(input, 'POST') : legacy.proxyPost(input),
    proxyPut: input => isNativeGmailAccount(input.accountId) ? request(input, 'PUT') : legacy.proxyPut(input),
    proxyPatch: input => isNativeGmailAccount(input.accountId) ? request(input, 'PATCH') : legacy.proxyPatch(input),
    proxyDelete: input => isNativeGmailAccount(input.accountId) ? request(input, 'DELETE') : legacy.proxyDelete(input),
    callAction: input => isNativeGmailAccount(input.accountId) ? request(input, 'POST') : legacy.callAction(input),
    boundedGmailGet: async (raw, signal) => {
      const input = BoundedGmailReadSchema.parse(raw);
      if (!isNativeGmailAccount(input.accountId)) {
        if (!legacy.boundedGmailGet) throw new Error('Integration read unavailable');
        return legacy.boundedGmailGet(input, signal);
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
      }
      return get({ externalUserId: input.externalUserId, accountId: input.accountId, url: target.href }, limit, signal);
    },
    boundedGmailLabels: async (raw, signal) => {
      const input = BoundedGmailLabelsSchema.parse(raw);
      if (!isNativeGmailAccount(input.accountId)) {
        if (!legacy.boundedGmailLabels) throw new Error('Mailbox labeling could not be confirmed');
        return legacy.boundedGmailLabels(input, signal);
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
      return body ? request({ ...identity, body }, 'POST', limit, signal) : get(identity, limit, signal);
    },
  };
}

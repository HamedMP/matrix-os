import { afterEach, expect, it, vi } from 'vitest';
import { PlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';
import { sendNativeStreamReply } from '../../desktop/src/main/chatgpt-plan/reply-delivery';
import { blocksPollDeliveryRecovery } from '../../desktop/src/main/chatgpt-plan/poll-delivery';
afterEach(() => vi.restoreAllMocks());
const ssl = () => new PlanFailure('peer_reply', 'network_error', undefined, undefined, { phase: 'before_headers', chromiumCode: 'ERR_SSL_PROTOCOL_ERROR' });
it.each([false, true])('retries a negotiated stream only, negotiated=%s', async enabled => {
  const post = vi.fn().mockRejectedValueOnce(ssl()).mockResolvedValue('ack');
  const result = sendNativeStreamReply({ enabled, signal: new AbortController().signal, current: () => true, post });
  if (enabled) { expect(await result).toBe('ack'); expect(post).toHaveBeenCalledTimes(2); }
  else { await expect(result).rejects.toThrow('network_error'); expect(post).toHaveBeenCalledOnce(); }
});
it('fails closed after one additional identical attempt', async () => {
  const post = vi.fn().mockRejectedValue(ssl());
  await expect(sendNativeStreamReply({ enabled: true, signal: new AbortController().signal, current: () => true, post })).rejects.toThrow('network_error');
  expect(post).toHaveBeenCalledTimes(2);
});
it.each(['cancel', 'source'])('rechecks %s before recovery', async action => {
  const control = new AbortController(); let current = true;
  const post = vi.fn().mockImplementation(() => { if (action === 'cancel') control.abort(); else current = false; throw ssl(); });
  await expect(sendNativeStreamReply({ enabled: true, signal: control.signal, current: () => current, post })).rejects.toThrow();
  expect(post).toHaveBeenCalledOnce();
});
it('Cancel interrupts the 100ms delay before another POST', async () => {
  const control = new AbortController(); const post = vi.fn().mockRejectedValue(ssl());
  const result = sendNativeStreamReply({ enabled: true, signal: control.signal, current: () => true, post });
  await new Promise(resolve => setImmediate(resolve)); control.abort();
  await expect(result).rejects.toThrow(); expect(post).toHaveBeenCalledOnce();
});
it.each(['ERR_CERT_AUTHORITY_INVALID', 'ERR_ACCESS_DENIED', 'ERR_CONNECTION_RESET', 'unknown'])('never borrows SSL recovery for %s', async code => {
  const error = new PlanFailure('peer_reply', 'network_error', undefined, undefined, { phase: 'before_headers', chromiumCode: code });
  const post = vi.fn().mockRejectedValue(error);
  await expect(sendNativeStreamReply({ enabled: true, signal: new AbortController().signal, current: () => true, post })).rejects.toBe(error);
  expect(post).toHaveBeenCalledOnce();
});
it('certificate/unknown causes veto generic SSL in the reply stage', async () => {
  expect(blocksPollDeliveryRecovery(new Error('net::ERR_SSL_PROTOCOL_ERROR', { cause: { code: 'CERT_HAS_EXPIRED' } }))).toBe(true);
  const error = new PlanFailure('peer_reply', 'network_error', undefined, undefined, { phase: 'body_read', chromiumCode: 'ERR_SSL_PROTOCOL_ERROR', causeCode: 'unknown' });
  const post = vi.fn().mockRejectedValue(error);
  await expect(sendNativeStreamReply({ enabled: true, signal: new AbortController().signal, current: () => true, post })).rejects.toBe(error);
  expect(post).toHaveBeenCalledOnce();
});

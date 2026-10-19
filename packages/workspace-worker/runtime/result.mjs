const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSdkSessionId = value => typeof value === 'string' && SESSION.test(value);
/** Gate durable completion on the actual kernel result, including refusal/abort. */
export function parseGatewayResult(text, options = {}) {
  if (text.length > 256_000) throw new Error('Agent result too large');
  const parsed = JSON.parse(text);
  const events = parsed?.events;
  if (!Array.isArray(events) || events.length > 2048
    || events.some((event) => !event || typeof event !== 'object' || Array.isArray(event)
      || ['error', 'kernel:error', 'aborted', 'refusal'].includes(event.type)
      || (event.type === 'result' && event.data?.errors?.length))
    || !events.some((event) => event.type === 'result' && typeof event.data?.result === 'string')) {
    throw new Error('Agent execution failed');
  }
  if (!options.requireSession) return { events };
  // /api/message returns KernelEvent[], not raw SDK session_id frames.
  // Require init and terminal result to agree. Kernel's stale-resume fallback
  // must never silently replace the Chat's already-associated conversation.
  const identities = events.filter(event => event.type === 'init' || event.type === 'result');
  const sessionId = identities[0]?.sessionId ?? identities[0]?.data?.sessionId;
  if (!isSdkSessionId(sessionId) || !events.some(event => event.type === 'init')
    || events.at(-1)?.type !== 'result'
    || identities.some(event => (event.type === 'init' ? event.sessionId : event.data?.sessionId) !== sessionId)
    || (options.expectedSessionId !== undefined && options.expectedSessionId !== sessionId)) {
    throw new Error('Agent execution failed');
  }
  return { events, sessionId };
}
export function summarizeGatewayResult(result) {
  const final = result.events.findLast((event) => event.type === 'result');
  if (typeof final?.data?.result === 'string') return final.data.result.slice(0,32_000);
  return result.events.filter((event) => event.type === 'text').map((event) => event.text ?? '').join('').slice(0,32_000);
}

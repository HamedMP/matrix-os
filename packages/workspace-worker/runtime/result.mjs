/** Gate durable completion on the actual kernel result, including refusal/abort. */
export function parseGatewayResult(text) {
  if (text.length > 256_000) throw new Error('Agent result too large');
  const parsed = JSON.parse(text);
  const events = parsed.events;
  if (!Array.isArray(events) || events.length > 2048
    || events.some((event) => ['error', 'kernel:error', 'aborted', 'refusal'].includes(event.type)
      || (event.type === 'result' && event.data?.errors?.length))
    || !events.some((event) => event.type === 'result' && typeof event.data?.result === 'string')) {
    throw new Error('Agent execution failed');
  }
  return { events };
}
export function summarizeGatewayResult(result) {
  const final = result.events.findLast((event) => event.type === 'result');
  if (typeof final?.data?.result === 'string') return final.data.result.slice(0,32_000);
  return result.events.filter((event) => event.type === 'text').map((event) => event.text ?? '').join('').slice(0,32_000);
}

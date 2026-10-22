/** Track the original provider body beneath parsers/transforms. A parser error
 * can precede source cancellation, so transformed-stream failure is not proof.
 * Failed or hanging cancellation deliberately leaves termination unconfirmed. */
export function observeRelayLocalResponse(upstream: Response): { response: Response; ended: Promise<void> } {
  if (!upstream.body) return { response: upstream, ended: Promise.resolve() };
  const reader = upstream.body.getReader();
  const termination = Promise.withResolvers<void>();
  let cancelling = false;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          if (!cancelling) termination.resolve();
          if (!cancelling) release();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        if (!cancelling) termination.resolve();
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelling = true;
      try {
        await reader.cancel(reason);
        termination.resolve();
      } finally {
        release();
      }
    },
  });
  return {
    response: new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers }),
    ended: termination.promise,
  };
}

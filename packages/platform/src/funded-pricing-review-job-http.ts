/** External responses are bounded by decoded bytes, including chunked responses. */
export async function readFundedPricingReviewText(response: Response, maxBytes: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (!response.ok || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))) {
    await response.body?.cancel();
    throw new Error("Pricing review source response rejected");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Pricing review source body missing");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error("Pricing review source response too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch (cancelError) {
      // A stream that already errored can reject cancellation with that same error.
      if (cancelError !== error) console.warn("[funded-pricing-review] source stream cancellation failed");
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

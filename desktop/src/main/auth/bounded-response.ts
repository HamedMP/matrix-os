// Reads a platform response body without buffering more than `limit` bytes, so
// a misbehaving upstream cannot grow trusted-core memory without bound.
export async function readBoundedResponseText(response: Response, limit: number, label: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel();
        throw new Error(`${label} response too large`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

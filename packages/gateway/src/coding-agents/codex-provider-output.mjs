// Resume replies on older providers can include image history even when the
// client requests metadata only. Bound the transport separately from tool text.
export const MAX_CODEX_TRANSPORT_BYTES = 16 * 1024 * 1024;

export class CodexTransportError extends Error {
  constructor(category, bytes) {
    super(`Codex transport ${category}`);
    this.category = category;
    this.bytes = bytes;
  }
}

export async function consumeCodexProviderOutput(stream, onMessage) {
  let buffer = Buffer.allocUnsafe(64 * 1024);
  let length = 0;
  const decode = new TextDecoder("utf-8", { fatal: true });
  async function dispatch() {
    const bytes = length;
    length = 0;
    // Accept blank lines and CRLF without interpreting them as messages.
    if (bytes === 0 || (bytes === 1 && buffer[0] === 13)) return;
    let message;
    try {
      message = JSON.parse(decode.decode(buffer.subarray(0, bytes)));
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
      throw new CodexTransportError("malformed", bytes);
    }
    await onMessage(message);
  }
  for await (const chunk of stream) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const size = length + end - offset;
      if (size > MAX_CODEX_TRANSPORT_BYTES) throw new CodexTransportError("oversized", size);
      if (size > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(MAX_CODEX_TRANSPORT_BYTES, Math.max(size, buffer.length * 2)));
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
      chunk.copy(buffer, length, offset, end);
      length = size;
      if (newline < 0) break;
      await dispatch();
      offset = newline + 1;
    }
  }
  if (length > 0) await dispatch();
}

export const MAX_CODEX_TRANSPORT_BYTES: number;
export class CodexTransportError extends Error {
  readonly category: "malformed" | "oversized";
  readonly bytes: number;
  constructor(category: "malformed" | "oversized", bytes: number);
}
export function consumeCodexProviderOutput(
  stream: AsyncIterable<Buffer>,
  onMessage: (message: unknown) => Promise<void>,
): Promise<void>;

/** A viewer process ending is not evidence that its observed command ended. */
export async function disconnectAttachmentClient(input: {
  current(): boolean;
  viewers: Array<{ onDisconnect?: () => void | Promise<void> }>;
  close(): Promise<void>;
}): Promise<void> {
  if (!input.current()) return;
  try { await input.close(); }
  finally {
    for (const viewer of input.viewers) {
      try { await viewer.onDisconnect?.(); }
      catch (error: unknown) { console.warn("[terminal-runtime] client disconnect delivery failed", error instanceof Error ? error.name : "unknown_error"); }
    }
  }
}

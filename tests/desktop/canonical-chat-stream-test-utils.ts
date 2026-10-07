import { act } from "@testing-library/react";
import type { CanonicalChatEventSource } from "../../packages/ui/src/canonical-chat-event-source";

/** Initial replay reconciliation belongs to setup, before testing healthy live delivery. */
export async function startCanonicalChatAfterReplay(source: CanonicalChatEventSource): Promise<void> {
  let dispose = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const replayed = new Promise<void>((resolve, reject) => {
    const subscription = source.subscribe(event => {
      if (event.type === "chat.full_refresh") resolve();
    });
    dispose = () => subscription.dispose();
    timeout = setTimeout(() => reject(new Error("Initial Chat replay did not complete")), 10_000);
  });
  try { await act(async () => { await source.start(); await replayed; }); }
  finally { dispose(); clearTimeout(timeout); }
}

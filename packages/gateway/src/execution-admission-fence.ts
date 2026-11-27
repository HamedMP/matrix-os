/** Shared synchronous admission gate. Shutdown closes admission permanently. */
export interface ExecutionAdmissionFence {
  readonly blocked: boolean;
  tryAcquire(): (() => void) | null;
  isChatBlocked(chatId: string): boolean;
  tryAcquireChat(chatId: string): (() => void) | null;
  close(): void;
}

export function createExecutionAdmissionFence(): ExecutionAdmissionFence {
  let blocked = false;
  let closed = false;
  let fencedChat: { chatId: string } | undefined;
  return {
    get blocked() { return blocked || closed; },
    close() { closed = true; },
    isChatBlocked(chatId) { return blocked || closed || fencedChat?.chatId === chatId; },
    tryAcquireChat(chatId) {
      if (closed || fencedChat) return null;
      const lease = { chatId };
      fencedChat = lease;
      return () => { if (fencedChat === lease) fencedChat = undefined; };
    },
    tryAcquire() {
      if (blocked || closed) return null;
      blocked = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        blocked = false;
      };
    },
  };
}

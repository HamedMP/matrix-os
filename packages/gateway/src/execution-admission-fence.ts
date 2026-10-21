/** Shared synchronous admission gate. Shutdown closes admission permanently. */
export interface ExecutionAdmissionFence {
  readonly blocked: boolean;
  tryAcquire(): (() => void) | null;
  close(): void;
}

export function createExecutionAdmissionFence(): ExecutionAdmissionFence {
  let blocked = false;
  let closed = false;
  return {
    get blocked() { return blocked || closed; },
    close() { closed = true; },
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

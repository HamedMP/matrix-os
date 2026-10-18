/** Shared synchronous admission gate. A holder must release on failure or shutdown. */
export interface ExecutionAdmissionFence {
  readonly blocked: boolean;
  tryAcquire(): (() => void) | null;
}

export function createExecutionAdmissionFence(): ExecutionAdmissionFence {
  let blocked = false;
  return {
    get blocked() { return blocked; },
    tryAcquire() {
      if (blocked) return null;
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

import { OfficeDocumentError } from "./document-error.js";

/**
 * When the caller stops waiting for an office request. The agent document
 * tools give up at their own deadline and tell the model the call failed, so
 * nothing may be started or saved for a request once its deadline has passed
 * or its caller has gone: the path queue, the engine run and the save each
 * check it before they go on. The budget the tools send is shorter than their
 * own wait, so the service always stops first.
 */
export class OfficeDeadline {
  private constructor(private readonly at: number, private readonly signal: AbortSignal | undefined) {}

  /** A deadline `ms` from now; `signal` ends it early when the caller disconnects. */
  static after(ms: number, signal?: AbortSignal): OfficeDeadline {
    return new OfficeDeadline(performance.now() + ms, signal);
  }

  /** Milliseconds left; 0 once the deadline has passed or the caller has gone. */
  remainingMs(): number {
    if (this.signal?.aborted) return 0;
    return Math.max(0, this.at - performance.now());
  }

  /** Throws `busy` once the deadline has passed: the caller no longer waits for `step`. */
  check(step: string): void {
    if (this.remainingMs() <= 0) throw new OfficeDocumentError("busy", `deadline passed before ${step}`);
  }
}

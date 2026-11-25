import {
  RUNTIME_WAKE_NOTICE_DELAY_MS,
  type RuntimeWakeErrorCode,
} from "@matrix-os/contracts/runtime-wake";

/**
 * Waking state of a sleeping Matrix computer (spec 2691, ENG-520), shared
 * with the UI alongside the connection state. `notice` turns on once a
 * request has waited 3 s for a wake and off when no request is waiting;
 * `failed` fires once when a request stops retrying.
 */
export type RuntimeWakeEvent =
  | { type: "notice"; visible: boolean }
  | { type: "failed"; code: RuntimeWakeErrorCode };

export type RuntimeWakeHandler = (event: RuntimeWakeEvent) => void;

/** Counts requests waiting on a wake and derives the notice from them. */
export class RuntimeWakeTracker {
  private handlers = new Set<RuntimeWakeHandler>();
  private waiting = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeVisible = false;

  get isNoticeVisible(): boolean {
    return this.noticeVisible;
  }

  subscribe(handler: RuntimeWakeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  begin(): void {
    this.waiting += 1;
    if (this.waiting !== 1 || this.noticeTimer) return;
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      if (this.waiting === 0 || this.noticeVisible) return;
      this.noticeVisible = true;
      this.emit({ type: "notice", visible: true });
    }, RUNTIME_WAKE_NOTICE_DELAY_MS);
  }

  end(): void {
    this.waiting = Math.max(0, this.waiting - 1);
    if (this.waiting > 0) return;
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    if (!this.noticeVisible) return;
    this.noticeVisible = false;
    this.emit({ type: "notice", visible: false });
  }

  fail(code: RuntimeWakeErrorCode): void {
    this.emit({ type: "failed", code });
  }

  private emit(event: RuntimeWakeEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

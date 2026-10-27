import { TerminalTabClientFrameSchema, type TerminalRef } from "@matrix-os/contracts";

export const TERMINAL_FIXTURE_REJECTION_PREFIX = "[matrix-terminal-fixture] rejected client frame";

export type TerminalFixtureClientFrame = ReturnType<typeof TerminalTabClientFrameSchema.parse>;

/** Keep the browser fake honest about the real terminal consumer contract. */
export abstract class ValidatedTerminalFixtureSocket {
  constructor(
    private readonly expectedRef: TerminalRef,
    private readonly onRejected?: () => void,
  ) {}

  private reject(message: string): never {
    this.onRejected?.();
    throw new Error(message);
  }

  send(raw: string): void {
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) this.reject("Terminal fixture rejected malformed JSON");
      throw error;
    }
    const parsed = TerminalTabClientFrameSchema.safeParse(candidate);
    if (!parsed.success) this.reject("Terminal fixture rejected an invalid client frame");
    const frame = parsed.data;
    if (frame.terminalRef.workspaceId !== this.expectedRef.workspaceId
      || frame.terminalRef.tabId !== this.expectedRef.tabId) {
      this.reject("Terminal fixture rejected a different terminal target");
    }
    this.onClientFrame(frame);
  }

  protected abstract onClientFrame(frame: TerminalFixtureClientFrame): void;
}

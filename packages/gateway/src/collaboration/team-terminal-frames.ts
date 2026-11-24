/**
 * Spec 2710: socket-side handling of team terminal input frames, shared by
 * the direct (relay) and proof-header terminal WebSocket routes. A refused
 * input is answered with a bounded `terminal.input_rejected` frame and the
 * socket stays open; revocation, a lost terminal or a flood still close it.
 */
import {
  CollaborationTeamTerminalInputRejectedFrameSchema,
  type CollaborationTeamTerminalInputAction,
  type CollaborationTeamTerminalRejectionCode,
} from "@matrix-os/contracts";
import { CollaborationTerminalDispatcherError } from "./terminal-dispatcher.js";

const DEFAULT_BYTES_PER_SECOND = 64 * 1024;
const DEFAULT_FRAMES_PER_SECOND = 200;
const DEFAULT_CLOSE_AFTER_SECONDS = 3;

export type TeamInputBudgetDecision = "ok" | "limited" | "close";

/**
 * Per-connection input budget (one-second windows). A connection over budget
 * in `closeAfterSeconds` consecutive seconds is closed. State is per socket
 * closure, so it needs no shared map or eviction.
 */
export class TeamInputBudget {
  private readonly now: () => number;
  private readonly bytesPerSecond: number;
  private readonly framesPerSecond: number;
  private readonly closeAfterSeconds: number;
  private window = Number.NaN;
  private bytes = 0;
  private frames = 0;
  private limitedWindow = Number.NaN;
  private consecutiveLimited = 0;

  constructor(options: { now?: () => number; bytesPerSecond?: number; framesPerSecond?: number; closeAfterSeconds?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.bytesPerSecond = options.bytesPerSecond ?? DEFAULT_BYTES_PER_SECOND;
    this.framesPerSecond = options.framesPerSecond ?? DEFAULT_FRAMES_PER_SECOND;
    this.closeAfterSeconds = options.closeAfterSeconds ?? DEFAULT_CLOSE_AFTER_SECONDS;
  }

  take(bytes: number): TeamInputBudgetDecision {
    const window = Math.floor(this.now() / 1_000);
    if (window !== this.window) {
      this.window = window;
      this.bytes = 0;
      this.frames = 0;
    }
    if (this.bytes + bytes <= this.bytesPerSecond && this.frames + 1 <= this.framesPerSecond) {
      this.bytes += bytes;
      this.frames += 1;
      return "ok";
    }
    if (window !== this.limitedWindow) {
      this.consecutiveLimited = window === this.limitedWindow + 1 ? this.consecutiveLimited + 1 : 1;
      this.limitedWindow = window;
    }
    return this.consecutiveLimited >= this.closeAfterSeconds ? "close" : "limited";
  }
}

function rejectionCode(error: unknown): CollaborationTeamTerminalRejectionCode | null {
  if (!(error instanceof CollaborationTerminalDispatcherError)) return null;
  if (error.code === "forbidden") return "forbidden";
  if (error.code === "input_paused" || error.code === "held") return "input_paused";
  return null;
}

/**
 * Handles one parsed team input action. Returns `handled` when the socket
 * should stay open (accepted, or refused with a frame) and `close` for a
 * flood. Errors that are not a bounded refusal propagate so the caller
 * closes the socket exactly as it does for legacy frames.
 */
export async function handleTeamTerminalFrame(input: {
  scopeId: string;
  action: CollaborationTeamTerminalInputAction;
  budget: TeamInputBudget;
  send(value: string): void;
  dispatch(): Promise<unknown>;
}): Promise<"handled" | "close"> {
  const reject = (code: CollaborationTeamTerminalRejectionCode) => {
    input.send(JSON.stringify(CollaborationTeamTerminalInputRejectedFrameSchema.parse({
      version: 1,
      type: "terminal.input_rejected",
      scopeId: input.scopeId,
      incarnation: input.action.incarnation,
      clientRequestId: input.action.clientRequestId,
      code,
    })));
  };
  const decision = input.budget.take(Buffer.byteLength(input.action.data));
  if (decision === "close") return "close";
  if (decision === "limited") {
    reject("rate_limited");
    return "handled";
  }
  try {
    await input.dispatch();
    return "handled";
  } catch (error: unknown) {
    const code = rejectionCode(error);
    if (!code) throw error;
    reject(code);
    return "handled";
  }
}

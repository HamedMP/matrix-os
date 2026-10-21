// What the terminal emulator has to run once it has booted, in order: a grid
// is applied before the output that was laid out for it. Both the number of
// entries and the amount of held output are capped, because an emulator that
// never boots must not let this grow.

export interface PendingTerminalOpsLimits {
  maxOps: number;
  maxWriteChars: number;
}

// One snapshot may be 5 MiB and arrives as a single write, so the output cap
// leaves room for it and for the output queued behind it.
export const DEFAULT_PENDING_TERMINAL_OPS_LIMITS: PendingTerminalOpsLimits = {
  maxOps: 256,
  maxWriteChars: 8 * 1024 * 1024,
};

type PendingOp =
  | { kind: "grid"; js: string }
  | { kind: "write"; js: string; chars: number };

export class PendingTerminalOps {
  private ops: PendingOp[] = [];
  private writeChars = 0;

  constructor(private readonly limits: PendingTerminalOpsLimits = DEFAULT_PENDING_TERMINAL_OPS_LIMITS) {}

  get size(): number {
    return this.ops.length;
  }

  /** A grid with no output after the previous one replaces it: only the last can matter. */
  pushGrid(js: string): void {
    if (this.ops.at(-1)?.kind === "grid") this.ops[this.ops.length - 1] = { kind: "grid", js };
    else this.ops.push({ kind: "grid", js });
    this.trim();
  }

  pushWrite(js: string, chars: number): void {
    this.ops.push({ kind: "write", js, chars });
    this.writeChars += chars;
    this.trim();
  }

  /** A clear or reset supersedes held output; the grid still has to be applied. */
  discardWrites(): void {
    let lastGrid: PendingOp | undefined;
    for (const op of this.ops) {
      if (op.kind === "grid") lastGrid = op;
    }
    this.ops = lastGrid ? [lastGrid] : [];
    this.writeChars = 0;
  }

  /** The script to run now, or null when nothing is held. */
  drain(): string | null {
    if (this.ops.length === 0) return null;
    const script = this.ops.map((op) => op.js).join(";");
    this.ops = [];
    this.writeChars = 0;
    return script;
  }

  // Drops the oldest output first. The newest entry is never dropped, so the
  // latest snapshot survives even when it alone is larger than the cap.
  private trim(): void {
    while (this.ops.length > this.limits.maxOps || this.writeChars > this.limits.maxWriteChars) {
      const oldest = this.ops.findIndex((op) => op.kind === "write");
      if (oldest === -1 || oldest === this.ops.length - 1) return;
      const [dropped] = this.ops.splice(oldest, 1);
      if (dropped?.kind === "write") this.writeChars -= dropped.chars;
      // The grids on either side are now adjacent, and the earlier one has
      // nothing left to lay out.
      if (this.ops[oldest - 1]?.kind === "grid" && this.ops[oldest]?.kind === "grid") {
        this.ops.splice(oldest - 1, 1);
      }
    }
  }
}

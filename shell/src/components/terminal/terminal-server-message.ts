export type TerminalServerMessage =
  | { type: "attached"; sessionId: string; state: "running" | "exited"; exitCode: number | null; fromSeq: number | null }
  | { type: "output"; data: string; seq: number | null }
  | { type: "block-mark"; seq: number | null; mark: { code: "A" | "B" | "C" | "D"; exitCode?: number } }
  | { type: "replay-start" }
  | { type: "replay-end" }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stripTerminalControls(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function parseTerminalServerMessage(raw: string): TerminalServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_err: unknown) {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case "attached": {
      const sessionId = typeof msg.sessionId === "string"
        ? msg.sessionId
        : typeof msg.session === "string"
          ? msg.session
          : null;
      if (!sessionId || (msg.state !== "running" && msg.state !== "exited")) {
        return null;
      }
      return {
        type: "attached",
        sessionId,
        state: msg.state,
        exitCode: toFiniteNumber(msg.exitCode),
        fromSeq: Number.isInteger(msg.fromSeq) && (msg.fromSeq as number) >= 0 ? (msg.fromSeq as number) : null,
      };
    }
    case "output":
      if (typeof msg.data !== "string") {
        return null;
      }
      return {
        type: "output",
        data: msg.data,
        seq: Number.isInteger(msg.seq) && (msg.seq as number) >= 0 ? (msg.seq as number) : null,
      };
    case "block-mark": {
      const mark = msg.mark;
      if (!mark || typeof mark !== "object" || !("code" in mark)) {
        return null;
      }
      const code = (mark as { code?: unknown }).code;
      if (code !== "A" && code !== "B" && code !== "C" && code !== "D") {
        return null;
      }
      const exitCode = toFiniteNumber((mark as { exitCode?: unknown }).exitCode);
      return {
        type: "block-mark",
        seq: Number.isInteger(msg.seq) && (msg.seq as number) >= 0 ? (msg.seq as number) : null,
        mark: exitCode === null ? { code } : { code, exitCode },
      };
    }
    case "replay-start":
      return { type: "replay-start" };
    case "replay-end":
      return { type: "replay-end" };
    case "exit":
      return { type: "exit", code: toFiniteNumber(msg.code) };
    case "error":
      return {
        type: "error",
        message: typeof msg.message === "string" ? msg.message : "Unknown error",
      };
    default:
      return null;
  }
}

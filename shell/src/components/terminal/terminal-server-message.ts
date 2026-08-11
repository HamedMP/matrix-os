import { TerminalServerFrameSchema } from "@matrix-os/contracts";
import { terminalRefKey } from "./terminal-session-id";

interface TerminalMessageIdentity {
  sessionId: string;
  revision: number;
}

export type TerminalServerMessage =
  | (TerminalMessageIdentity & {
      type: "attached";
      state: "running";
      exitCode: null;
      fromSeq: number;
      canonicalSize: TerminalCanonicalSize;
    })
  | (TerminalMessageIdentity & { type: "canonical-size"; cols: number; rows: number })
  | (TerminalMessageIdentity & { type: "output"; data: string; seq: number })
  | (TerminalMessageIdentity & {
      type: "snapshot";
      data: string;
      seq: number;
      canonicalSize: TerminalCanonicalSize;
    })
  | (TerminalMessageIdentity & { type: "replay-start" })
  | (TerminalMessageIdentity & { type: "replay-end" })
  | (TerminalMessageIdentity & { type: "pong" })
  | (TerminalMessageIdentity & { type: "exit"; code: number | null })
  | { type: "error"; message: string; sessionId?: string };

export interface TerminalCanonicalSize {
  cols: number;
  rows: number;
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

  const validated = TerminalServerFrameSchema.safeParse(parsed);
  if (!validated.success) return null;
  const msg = validated.data;

  if (msg.type === "error" || msg.type === "safe-error") {
    return {
      type: "error",
      message: msg.type === "error" ? msg.message : msg.error.safeMessage,
      ...(msg.terminalRef ? { sessionId: terminalRefKey(msg.terminalRef) } : {}),
    };
  }

  const identity: TerminalMessageIdentity = {
    sessionId: terminalRefKey(msg.terminalRef),
    revision: msg.revision,
  };
  switch (msg.type) {
    case "attached":
      return {
        ...identity,
        type: "attached",
        state: "running",
        exitCode: null,
        fromSeq: msg.nextSeq,
        canonicalSize: msg.canonicalSize,
      };
    case "canonical-size":
      return { ...identity, type: "canonical-size", ...msg.canonicalSize };
    case "output":
      return { ...identity, type: "output", data: msg.data, seq: msg.seq };
    case "snapshot":
      return {
        ...identity,
        type: "snapshot",
        data: msg.ansi,
        seq: msg.seq,
        canonicalSize: msg.canonicalSize,
      };
    case "replay-start":
    case "replay-evicted":
    case "replay-gap":
      return { ...identity, type: "replay-start" };
    case "replay-end":
      return { ...identity, type: "replay-end" };
    case "pong":
      return { ...identity, type: "pong" };
    case "exit":
      return { ...identity, type: "exit", code: msg.exitCode };
  }
}

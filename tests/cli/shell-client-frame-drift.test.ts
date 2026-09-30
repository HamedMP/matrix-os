import { TerminalTabServerFrameSchema } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import { ShellServerFrameSchema } from "../../packages/sync-client/src/cli/shell-server-frame-schema.js";

type FrameOption = z.ZodObject<z.ZodRawShape>;

const terminalRef = {
  workspaceId: `tws_${"1".repeat(32)}`,
  tabId: `tt_${"2".repeat(32)}`,
};

const representativeFrames = [
  {
    type: "attached",
    terminalRef,
    revision: Number.MAX_SAFE_INTEGER,
    canonicalSize: { cols: 500, rows: 200 },
    nextSeq: Number.MAX_SAFE_INTEGER,
    capabilities: ["binary-input-v1", "native-scroll-v1"],
    ownership: "observer",
    leaseEpoch: Number.MAX_SAFE_INTEGER,
  },
  {
    type: "snapshot",
    terminalRef,
    revision: Number.MAX_SAFE_INTEGER,
    canonicalSize: { cols: 500, rows: 200 },
    presentationRevision: Number.MAX_SAFE_INTEGER,
    seq: Number.MAX_SAFE_INTEGER,
    ansi: "x".repeat(5 * 1024 * 1024),
    viewport: { top: Number.MAX_SAFE_INTEGER, rows: 200 },
  },
  { type: "output", terminalRef, revision: 0, seq: 0, data: "x".repeat(64 * 1024) },
  { type: "replay-start", terminalRef, revision: 0, fromSeq: 0 },
  { type: "replay-evicted", terminalRef, revision: 0, fromSeq: 0, nextSeq: 0 },
  { type: "replay-gap", terminalRef, revision: 0, fromSeq: 0, nextSeq: 0 },
  { type: "replay-end", terminalRef, revision: 0, nextSeq: 0, toSeq: null },
  { type: "canonical-size", terminalRef, revision: 0, canonicalSize: { cols: 20, rows: 5 } },
  { type: "pong", terminalRef, revision: 0 },
  { type: "exit", terminalRef, revision: 0, exitCode: null },
  { type: "lease-revoked", terminalRef, epoch: Number.MAX_SAFE_INTEGER },
  { type: "error", terminalRef, code: "session_unavailable", message: "Terminal session is unavailable." },
  {
    type: "safe-error",
    terminalRef,
    error: {
      code: "session_unavailable",
      safeMessage: "Terminal session is unavailable. Start a new session.",
      retryable: false,
      recoveryActions: ["retry", "sign_in", "select_runtime", "open_setup_terminal", "resume", "start_new_session"],
    },
  },
] as const;

function fieldsByFrameType(options: readonly unknown[]): Map<string, string[]> {
  return new Map((options as FrameOption[]).map((option) => {
    const type = (option.shape.type as z.ZodLiteral<string>).value;
    return [type, Object.keys(option.shape).sort()];
  }));
}

describe("CLI terminal frame schema", () => {
  // This catches newly added strict-object fields; the boundary fixtures below
  // separately prove that the CLI accepts representative contract-valid values.
  it("keeps strict top-level fields synchronized for each frame the CLI handles", () => {
    const cli = fieldsByFrameType(ShellServerFrameSchema.options);
    const contract = fieldsByFrameType(TerminalTabServerFrameSchema.options);

    for (const [type, cliFields] of cli) {
      expect(contract.has(type), `contract lost frame type ${type}`).toBe(true);
      expect(cliFields, `CLI ${type} frame fields`).toEqual(contract.get(type));
    }
  });

  it("accepts representative contract-valid frames at their boundaries", () => {
    for (const frame of representativeFrames) {
      const contractFrame = TerminalTabServerFrameSchema.parse(frame);
      expect(
        ShellServerFrameSchema.safeParse(contractFrame),
        `CLI rejected contract-valid ${frame.type} frame`,
      ).toMatchObject({ success: true });
    }
  });
});

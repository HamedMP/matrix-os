import { describe, expect, it } from "vitest";
import {
  MacVerificationTerminalIntentSchema,
  macVerificationTerminalIntentPath,
} from "@matrix-os/contracts/mac-verification-terminal";

const intent = {
  version: 1,
  chatId: "chat_demo",
  runId: "run_latest",
  projectId: "project_matrix",
  worktreeId: "wt_123456789abc",
  recipe: "files-trash",
  baseSha: "b".repeat(40),
  sourceSha256: "d".repeat(64),
};

describe("Terminal Mac Verification requests", () => {
  it("binds an allowlisted recipe and exact worktree source", () => {
    expect(MacVerificationTerminalIntentSchema.parse(intent)).toEqual(intent);
    expect(MacVerificationTerminalIntentSchema.safeParse({ ...intent, recipe: "shell" }).success).toBe(false);
    expect(MacVerificationTerminalIntentSchema.safeParse({ ...intent, args: "whoami" }).success).toBe(false);
    expect(MacVerificationTerminalIntentSchema.safeParse({ ...intent, worktreeId: "../main" }).success).toBe(false);
    expect(MacVerificationTerminalIntentSchema.safeParse({ ...intent, sourceSha256: "stale" }).success).toBe(false);
  });

  it("maps even a long Chat and run ID to one bounded, stable attachment name", async () => {
    const chat = "chat_" + "x".repeat(128);
    const run = "run_" + "y".repeat(128);
    const path = await macVerificationTerminalIntentPath(chat, run);
    expect(path).toMatch(/^temporary\/desktop-chat\/mac-verification-[a-f0-9]{64}\.json$/);
    expect(await macVerificationTerminalIntentPath(chat, run)).toBe(path);
    expect(await macVerificationTerminalIntentPath(chat, "run_different")).not.toBe(path);
    await expect(macVerificationTerminalIntentPath("chat_../other", run)).rejects.toThrow();
  });
});

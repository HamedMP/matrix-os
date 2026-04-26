import { describe, expect, it } from "vitest";
import { shellCommand } from "../../packages/sync-client/src/cli/commands/shell.js";

describe("shell CLI command", () => {
  it("exports the shell command namespace", () => {
    expect(shellCommand.meta?.name).toBe("shell");
  });

  it("registers ls, new, attach, and rm session subcommands", () => {
    expect(Object.keys(shellCommand.subCommands ?? {}).sort()).toEqual([
      "attach",
      "ls",
      "new",
      "rm",
    ]);
  });
});

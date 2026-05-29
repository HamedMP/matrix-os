import { afterEach, describe, expect, it, vi } from "vitest";
import { profileCommand } from "../../src/cli/commands/profile.js";

describe("profile command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not print parent usage after a profile subcommand", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    profileCommand.run?.({ args: {}, rawArgs: ["show", "local"] });

    expect(stdout).not.toHaveBeenCalled();
  });

  it("prints usage when no profile subcommand is present", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    profileCommand.run?.({ args: {}, rawArgs: [] });

    expect(stdout).toHaveBeenCalledWith("Usage: matrix profile ls|show|use|set");
  });
});

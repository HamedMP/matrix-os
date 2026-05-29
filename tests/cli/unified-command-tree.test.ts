import { describe, expect, it } from "vitest";
import {
  PUBLISHED_CLI_COMMANDS,
  resolvePublishedCliRedirect,
} from "../../packages/cli/src/index.js";
import { completionCommand } from "../../packages/sync-client/src/cli/commands/completion.js";

describe("unified CLI command tree", () => {
  it("redirects cloud-first commands to the published CLI entry", () => {
    expect(resolvePublishedCliRedirect(["profile", "ls", "--json"])).toEqual([
      "profile",
      "ls",
      "--json",
    ]);
    expect(resolvePublishedCliRedirect(["status", "--profile", "cloud"])).toEqual([
      "status",
      "--profile",
      "cloud",
    ]);
    expect(resolvePublishedCliRedirect(["sh", "ls"])).toEqual(["sh", "ls"]);
  });

  it("keeps development-only commands out of the published redirect set", () => {
    expect(PUBLISHED_CLI_COMMANDS.has("start")).toBe(false);
    expect(PUBLISHED_CLI_COMMANDS.has("send")).toBe(false);
    expect(resolvePublishedCliRedirect(["start", "--shell"])).toBeNull();
    expect(resolvePublishedCliRedirect(["send", "hello"])).toBeNull();
  });

  it("does not expose the removed SSH command surface", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => {
      logs.push(String(line));
    };
    try {
      await completionCommand.run?.({ args: {} } as never);
    } finally {
      console.log = originalLog;
    }

    expect(PUBLISHED_CLI_COMMANDS.has("ssh")).toBe(false);
    expect(PUBLISHED_CLI_COMMANDS.has("keys")).toBe(false);
    expect(resolvePublishedCliRedirect(["ssh"])).toBeNull();
    expect(resolvePublishedCliRedirect(["keys", "add"])).toBeNull();
    const completed = logs.join("\n").split(/\s+/);
    expect(completed).not.toContain("ssh");
    expect(completed).not.toContain("keys");
  });

  it("prints installable shell completion scripts", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => {
      logs.push(String(line));
    };
    try {
      await completionCommand.run?.({ args: { shell: "zsh" } } as never);
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("#compdef matrix");
    expect(logs.join("\n")).toContain("connect");
    expect(logs.join("\n")).not.toContain("ssh");
  });

  it("prints dynamic shell session completion for attach/connect/rm", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => {
      logs.push(String(line));
    };
    try {
      await completionCommand.run?.({ args: { shell: "bash" } } as never);
    } finally {
      console.log = originalLog;
    }

    const script = logs.join("\n");
    expect(script).toContain("_matrix_shell_sessions");
    expect(script).toContain("matrix shell list --json");
    expect(script).toContain('"connect" || "$shell_command" == "attach" || "$shell_command" == "rm"');
  });

  it("prevents fish shell command completions from mixing with session completions", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => {
      logs.push(String(line));
    };
    try {
      await completionCommand.run?.({ args: { shell: "fish" } } as never);
    } finally {
      console.log = originalLog;
    }

    const script = logs.join("\n");
    expect(script).toContain("and not __fish_seen_subcommand_from list ls new connect attach rm tab pane layout");
    expect(script).toContain("__fish_seen_subcommand_from connect attach rm");
  });
});

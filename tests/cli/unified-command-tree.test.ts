import { describe, expect, it } from "vitest";
import {
  PUBLISHED_CLI_COMMANDS,
  normalizeLeadingGlobalFlags,
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
    expect(resolvePublishedCliRedirect(["port", "forward", "3000"])).toEqual([
      "port",
      "forward",
      "3000",
    ]);
    expect(resolvePublishedCliRedirect(["forward", "3000"])).toEqual([
      "forward",
      "3000",
    ]);
  });

  it("normalizes documented leading global flags before command dispatch", () => {
    expect(normalizeLeadingGlobalFlags(["--profile", "local", "status"])).toEqual([
      "status",
      "--profile",
      "local",
    ]);
    expect(normalizeLeadingGlobalFlags(["--json", "profile", "ls"])).toEqual([
      "profile",
      "ls",
      "--json",
    ]);
    expect(normalizeLeadingGlobalFlags(["--profile=local", "shell", "ls"])).toEqual([
      "shell",
      "ls",
      "--profile=local",
    ]);
    expect(normalizeLeadingGlobalFlags([
      "--gateway",
      "http://localhost:4000",
      "--platform=https://app.matrix-os.com",
      "--token",
      "token-1",
      "--quiet",
      "-v",
      "status",
    ])).toEqual([
      "status",
      "--gateway",
      "http://localhost:4000",
      "--platform=https://app.matrix-os.com",
      "--token",
      "token-1",
      "--quiet",
      "-v",
    ]);
    expect(normalizeLeadingGlobalFlags(["--profile", "--json", "status"])).toEqual([
      "status",
      "--profile",
      "--json",
    ]);
  });

  it("redirects published commands when documented global flags lead", () => {
    expect(resolvePublishedCliRedirect(["--profile", "local", "status"])).toEqual([
      "status",
      "--profile",
      "local",
    ]);
    expect(resolvePublishedCliRedirect(["--json", "profile", "ls"])).toEqual([
      "profile",
      "ls",
      "--json",
    ]);
    expect(resolvePublishedCliRedirect(["--profile=local", "shell", "ls"])).toEqual([
      "shell",
      "ls",
      "--profile=local",
    ]);
  });

  it("does not normalize arbitrary leading flags or development commands", () => {
    expect(normalizeLeadingGlobalFlags(["--unknown", "profile", "ls"])).toEqual([
      "--unknown",
      "profile",
      "ls",
    ]);
    expect(resolvePublishedCliRedirect(["--json", "start", "--shell"])).toBeNull();
  });

  it("keeps development-only commands out of the published redirect set", () => {
    expect(PUBLISHED_CLI_COMMANDS.has("start")).toBe(false);
    expect(PUBLISHED_CLI_COMMANDS.has("send")).toBe(false);
    expect(PUBLISHED_CLI_COMMANDS.has("port")).toBe(true);
    expect(PUBLISHED_CLI_COMMANDS.has("forward")).toBe(true);
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

  it("prints authenticated Matrix path completion for upload and download", async () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (line?: unknown) => {
        logs.push(String(line));
      };
      try {
        await completionCommand.run?.({ args: { shell } } as never);
      } finally {
        console.log = originalLog;
      }

      const script = logs.join("\n");
      expect(script).toContain("matrix completion paths");
      expect(script).toContain("upload");
      expect(script).toContain("download");
    }
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

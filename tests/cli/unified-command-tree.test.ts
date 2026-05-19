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
});

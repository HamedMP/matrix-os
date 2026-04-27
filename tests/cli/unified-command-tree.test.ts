import { describe, expect, it } from "vitest";
import {
  PUBLISHED_CLI_COMMANDS,
  resolvePublishedCliRedirect,
} from "../../packages/cli/src/index.js";

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
});

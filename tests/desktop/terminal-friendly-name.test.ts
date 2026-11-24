import { describe, expect, it } from "vitest";
import { friendlyTerminalName } from "@desktop/renderer/src/features/terminal-window/terminal-friendly-name";

// ENG-521: the end confirm names the terminal by its agent topic or tab name, never the raw prompt.
describe("a terminal's friendly name", () => {
  it("keeps an agent topic or tab name and replaces a shell prompt title", () => {
    expect(friendlyTerminalName({ name: "Fix the login flow", space: undefined })).toBe("Fix the login flow");
    expect(friendlyTerminalName({ name: "build", space: "app" })).toBe("build");
    expect(friendlyTerminalName({ name: "hamed@Ubuntu-noble: ~", space: undefined })).toBe("Terminal");
    expect(friendlyTerminalName({ name: "me@box:~/src", space: "matrix-os" })).toBe("Terminal in matrix-os");
    expect(friendlyTerminalName({ name: "me@box:~$", space: undefined })).toBe("Terminal");
    expect(friendlyTerminalName({ name: "root@vps:/var/log#", space: "ops" })).toBe("Terminal in ops");
    // Fault detected (Greptile, #3642): a prompt with a spaced path kept the raw title.
    expect(friendlyTerminalName({ name: "me@box:~/My Projects", space: undefined })).toBe("Terminal");
    expect(friendlyTerminalName({ name: "me@box: ~/My Projects/site $", space: "site" })).toBe("Terminal in site");
    // Fault detected (Greptile, #3642): chosen names ending in a prompt-like sign became "Terminal".
    expect(friendlyTerminalName({ name: "C#", space: undefined })).toBe("C#");
    expect(friendlyTerminalName({ name: "Build 100%", space: undefined })).toBe("Build 100%");
    expect(friendlyTerminalName({ name: "Deploy to prod >", space: undefined })).toBe("Deploy to prod >");
    expect(friendlyTerminalName({ name: "email me@team: re budget", space: undefined })).toBe("email me@team: re budget");
    expect(friendlyTerminalName(undefined)).toBe("Terminal");
  });
});

import { describe, expect, it } from "vitest";
import { friendlyTerminalName } from "@desktop/renderer/src/features/terminal-window/terminal-friendly-name";

// ENG-521: the end confirm names the terminal by its agent topic or tab name, never the raw prompt.
describe("a terminal's friendly name", () => {
  it("keeps an agent topic or tab name and replaces a shell prompt title", () => {
    expect(friendlyTerminalName({ name: "Fix the login flow", space: undefined })).toBe("Fix the login flow");
    expect(friendlyTerminalName({ name: "build", space: "app" })).toBe("build");
    expect(friendlyTerminalName({ name: "hamed@Ubuntu-noble: ~", space: undefined })).toBe("Terminal");
    expect(friendlyTerminalName({ name: "me@box:~/src", space: "matrix-os" })).toBe("Terminal in matrix-os");
    expect(friendlyTerminalName({ name: "bash-5.2$ ", space: undefined })).toBe("Terminal");
    expect(friendlyTerminalName(undefined)).toBe("Terminal");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createOrAttachRunSession,
  parseRunCommand,
  quoteCommandArg,
  runCommand,
} from "../../packages/sync-client/src/cli/commands/run.js";
import { PUBLISHED_CLI_COMMANDS, resolvePublishedCliRedirect } from "../../packages/cli/src/index.js";

describe("run CLI command", () => {
  it("exports the developer run command", () => {
    expect(runCommand.meta?.name).toBe("run");
    expect(PUBLISHED_CLI_COMMANDS.has("run")).toBe(true);
    expect(resolvePublishedCliRedirect(["run", "-it", "--", "claude"])).toEqual([
      "run",
      "-it",
      "--",
      "claude",
    ]);
  });

  it("parses command argv after -- without treating Matrix flags as remote command args", () => {
    expect(parseRunCommand(["-it", "--session", "setup", "-C", "projects/app", "--", "gh", "auth", "login"])).toEqual([
      "gh",
      "auth",
      "login",
    ]);
    expect(parseRunCommand(["-it", "--cwd", "projects/app", "pnpm", "test"])).toEqual(["pnpm", "test"]);
    expect(parseRunCommand(["-it", "--cwd=projects/app", "pnpm", "test"])).toEqual(["pnpm", "test"]);
    expect(parseRunCommand(["-it", "--session=setup", "claude"])).toEqual(["claude"]);
  });

  it("attaches existing named sessions instead of failing create-or-attach", async () => {
    const client = {
      createSession: vi.fn(async () => {
        throw Object.assign(new Error("Request failed"), { code: "session_exists" });
      }),
      attachSession: vi.fn(async () => ({ detached: true })),
    };

    await expect(
      createOrAttachRunSession(client, {
        name: "setup",
        command: ["claude"],
        sessionProvided: true,
      }),
    ).resolves.toEqual({ detached: true });
    expect(client.attachSession).toHaveBeenCalledWith("setup");
  });

  it("does not reuse an accidental ephemeral session collision", async () => {
    const client = {
      createSession: vi.fn(async () => {
        throw Object.assign(new Error("Request failed"), { code: "session_exists" });
      }),
      attachSession: vi.fn(async () => ({ detached: true })),
    };

    await expect(
      createOrAttachRunSession(client, {
        name: "run-collision",
        command: ["claude"],
        sessionProvided: false,
      }),
    ).rejects.toMatchObject({ code: "session_exists" });
    expect(client.attachSession).not.toHaveBeenCalled();
  });

  it("quotes remote argv so shell sessions preserve spaces and single quotes", () => {
    expect(["gh", "auth", "login"].map(quoteCommandArg).join(" ")).toBe("gh auth login");
    expect(["echo", "hello world", "it's ok"].map(quoteCommandArg).join(" ")).toBe(
      "echo 'hello world' 'it'\\''s ok'",
    );
  });
});

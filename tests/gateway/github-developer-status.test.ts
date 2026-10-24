import { describe, expect, it, vi } from "vitest";
import { getGithubDeveloperStatus } from "../../packages/gateway/src/github-developer-status.js";

describe("github developer status", () => {
  it("explains when an authenticated account still uses HTTPS", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "gh" && args[0] === "--version") {
        return { stdout: "gh version 2.86.0\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "auth" && args[1] === "status") {
        return { stdout: "", stderr: "" };
      }
      if (command === "gh" && args[0] === "config") {
        return { stdout: "https\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "api") {
        return { stdout: "octocat\n", stderr: "" };
      }
      if (command === "ssh") {
        return {
          stdout: "",
          stderr: "Hi octocat! You've successfully authenticated, but GitHub does not provide shell access.\n",
        };
      }
      if (command === "git" && args.includes("user.name")) {
        return { stdout: "The Octocat\n", stderr: "" };
      }
      if (command === "git" && args.includes("user.email")) {
        return { stdout: "583231+octocat@users.noreply.github.com\n", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    await expect(getGithubDeveloperStatus({ homePath: "/home/matrix/home", runCommand }))
      .resolves.toMatchObject({
        installed: true,
        authenticated: true,
        gitProtocol: "https",
        sshStatus: "verified",
        commitIdentity: { status: "ready" },
        ready: false,
        errorCode: "github_ssh_protocol_required",
      });
  });
});

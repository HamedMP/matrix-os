import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { getGithubDeveloperStatus } from "../../packages/gateway/src/github-developer-status.js";

describe("github developer status", () => {
  afterEach(() => vi.unstubAllEnvs());

  function readyRunner(sshLogin = "octocat", sshExit = 0) {
    return vi.fn(async (command: string, args: string[], _options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv }) => {
      if (command === "ssh") {
        const stderr = `Hi ${sshLogin}! You've successfully authenticated, but GitHub does not provide shell access.\n`;
        if (sshExit !== 0) throw Object.assign(new Error("ssh exited"), { code: sshExit, stderr });
        return { stdout: "", stderr };
      }
      if (command === "git") return { stdout: args.includes("user.name") ? "Owner\n" : "owner@example.com\n", stderr: "" };
      if (args[0] === "api") return { stdout: "octocat\n", stderr: "" };
      if (args[0] === "config") return { stdout: "ssh\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
  }

  it.each([0, 1])("refuses a different SSH account even when SSH exits %s", async (exit) => {
    const result = await getGithubDeveloperStatus({ homePath: "/owner-home", runCommand: readyRunner("another-owner", exit) });
    expect(result).toMatchObject({ authenticated: true, user: "octocat", sshStatus: "setup_required", ready: false, errorCode: "github_ssh_setup_required" });
  });

  it("accepts the matching account greeting from SSH's normal exit 1", async () => {
    await expect(getGithubDeveloperStatus({ homePath: "/owner-home", runCommand: readyRunner("Octocat", 1) }))
      .resolves.toMatchObject({ sshStatus: "verified", ready: true });
  });

  it("binds every probe to the owner home and excludes inherited credentials and Git overrides", async () => {
    for (const [key, value] of Object.entries({
      HOME: "/different-home", GH_CONFIG_DIR: "/different-gh", GIT_CONFIG_GLOBAL: "/different-git", GH_TOKEN: "synthetic-token",
      GITHUB_TOKEN: "synthetic-token", GH_HOST: "elsewhere.example", GIT_SSH_COMMAND: "synthetic-command", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.email", GIT_CONFIG_VALUE_0: "other@example.com",
      GIT_AUTHOR_NAME: "Service", GIT_AUTHOR_EMAIL: "service@example.com", GIT_COMMITTER_NAME: "Service", GIT_COMMITTER_EMAIL: "service@example.com",
      GIT_EXEC_PATH: "/different-git", GIT_PROXY_COMMAND: "synthetic-command", GIT_TEMPLATE_DIR: "/different-templates", GIT_ASKPASS: "synthetic-command", GIT_SSH_VARIANT: "plink", GH_REPO: "another/repository", GATEWAY_SECRET: "synthetic-service-secret",
    })) vi.stubEnv(key, value);
    const runCommand = readyRunner();
    await getGithubDeveloperStatus({ homePath: "/owner-home", runCommand });
    for (const [, , options] of runCommand.mock.calls) {
      expect(options.env).toMatchObject({ HOME: "/owner-home", GH_CONFIG_DIR: join("/owner-home", ".config", "gh"), GIT_CONFIG_GLOBAL: join("/owner-home", ".gitconfig") });
      for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_EXEC_PATH", "GIT_PROXY_COMMAND", "GIT_TEMPLATE_DIR", "GIT_ASKPASS", "GIT_SSH_VARIANT", "GH_REPO", "GATEWAY_SECRET"]) expect(options.env?.[key]).toBeUndefined();
    }
  });

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

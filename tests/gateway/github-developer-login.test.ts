import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("distro/customer-vps/host-bin/matrix-github-developer-login");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe("matrix-github-developer-login", () => {
  let root: string;
  let homePath: string;
  let binPath: string;
  let logPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "matrix-github-login-"));
    homePath = join(root, "home");
    binPath = join(root, "bin");
    logPath = join(root, "commands.jsonl");
    await Promise.all([
      mkdir(homePath, { recursive: true }),
      mkdir(binPath, { recursive: true }),
    ]);
    const fake = join(binPath, "fake-command.mjs");
    await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ command, args }) + "\\n");
if (command === "gh") {
  if (args[0] === "auth" && args[1] === "login") {
    if (process.env.FAKE_CANCEL_LOGIN === "1") {
      console.error("cancelled ghp_secret_that_must_not_escape");
      process.exit(130);
    }
    if (process.env.FAKE_LOGIN_PROMPT === "1") {
      process.stdout.write("Choose an SSH key: ");
      await new Promise((resolvePrompt) => {
        const timer = setTimeout(() => process.exit(12), 2_000);
        process.stdin.once("data", () => {
          clearTimeout(timer);
          resolvePrompt();
        });
      });
      process.exit(0);
    }
    process.exit(0);
  }
  if (args[0] === "auth" && args[1] === "setup-git") process.exit(0);
  if (args[0] === "api" && args[1] === "user") {
    console.log(JSON.stringify({ id: 583231, login: "octocat", name: "The Octocat" }));
    process.exit(0);
  }
}
if (command === "ssh") {
  console.error("Hi octocat! You've successfully authenticated, but GitHub does not provide shell access.");
  process.exit(1);
}
if (command === "git") {
  const key = args.at(-1);
  if (args.includes("--get")) {
    if (process.env.FAKE_IDENTITY_READY === "1") {
      console.log(key === "user.name" ? "Existing Owner" : "owner@example.com");
      process.exit(0);
    }
    process.exit(1);
  }
  if (args.includes("--replace-all")) process.exit(0);
}
process.exit(9);
`);
    await chmod(fake, 0o755);
    await Promise.all([
      symlink("fake-command.mjs", join(binPath, "gh")),
      symlink("fake-command.mjs", join(binPath, "git")),
      symlink("fake-command.mjs", join(binPath, "ssh")),
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function runLogin(input = "", extraEnv: NodeJS.ProcessEnv = {}): Promise<RunResult> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [SCRIPT], {
        cwd: homePath,
        env: {
          ...process.env,
          HOME: homePath,
          MATRIX_HOME: homePath,
          PATH: `${binPath}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          FAKE_COMMAND_LOG: logPath,
          ...extraEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let promptAnswered = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (
          !promptAnswered
          && extraEnv.FAKE_LOGIN_PROMPT === "1"
          && stdout.includes("Choose an SSH key: ")
        ) {
          promptAnswered = true;
          child.stdin.write("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", rejectRun);
      const inputTimer = setInterval(async () => {
        try {
          const log = await readFile(logPath, "utf8");
          if (!log.includes('"user.email"')) return;
          clearInterval(inputTimer);
          child.stdin.end(input);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") rejectRun(error);
        }
      }, 10);
      child.on("close", (code) => {
        clearInterval(inputTimer);
        child.stdin.end();
        resolveRun({ code, stdout, stderr });
      });
    });
  }

  async function commands(): Promise<Array<{ command: string; args: string[] }>> {
    return (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { command: string; args: string[] });
  }

  it("runs the fixed browser login, pins GitHub hosts, verifies SSH, and saves confirmed suggestions", async () => {
    const result = await runLogin("\n\n");

    expect(result.code).toBe(0);
    expect(await commands()).toEqual([
      {
        command: "gh",
        args: ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "ssh"],
      },
      { command: "gh", args: ["auth", "setup-git", "--hostname", "github.com"] },
      {
        command: "ssh",
        args: expect.arrayContaining([
          "-T",
          "BatchMode=yes",
          "StrictHostKeyChecking=yes",
          "GlobalKnownHostsFile=/dev/null",
          "git@github.com",
        ]),
      },
      { command: "gh", args: ["api", "user"] },
      { command: "git", args: ["config", "--global", "--get", "user.name"] },
      { command: "git", args: ["config", "--global", "--get", "user.email"] },
      { command: "git", args: ["config", "--global", "--replace-all", "user.name", "The Octocat"] },
      {
        command: "git",
        args: ["config", "--global", "--replace-all", "user.email", "583231+octocat@users.noreply.github.com"],
      },
    ]);
    const knownHosts = await readFile(join(homePath, ".ssh", "matrix-github-known-hosts"), "utf8");
    expect(knownHosts).toContain("github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl");
    expect(knownHosts).toContain("github.com ecdsa-sha2-nistp256");
    expect(knownHosts).toContain("github.com ssh-rsa");
    await expect(readFile(join(homePath, ".ssh", "config"), "utf8"))
      .resolves.toMatch(/^Include ~\/\.ssh\/matrix-github\.conf\n/);
    expect(result.stdout).toContain("GitHub developer access is ready for octocat.");
  });

  it("preserves an existing valid Git identity and delegates key selection to GitHub CLI", async () => {
    const result = await runLogin("", { FAKE_IDENTITY_READY: "1" });

    expect(result.code).toBe(0);
    const calls = await commands();
    expect(calls.filter((call) => call.command === "git" && call.args.includes("--replace-all"))).toEqual([]);
    expect(calls[0]).toEqual({
      command: "gh",
      args: ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "ssh"],
    });
    expect(calls[0]?.args.join(" ")).not.toMatch(/private|id_rsa|key-file/i);
  });

  it("lets the owner edit both identity suggestions before saving them", async () => {
    const result = await runLogin("Octo Owner\nowner@example.com\n");

    expect(result.code).toBe(0);
    expect(await commands()).toEqual(expect.arrayContaining([
      { command: "git", args: ["config", "--global", "--replace-all", "user.name", "Octo Owner"] },
      { command: "git", args: ["config", "--global", "--replace-all", "user.email", "owner@example.com"] },
    ]));
  });

  it("shows a non-newline GitHub CLI prompt before the command waits for input", async () => {
    const result = await runLogin("\n\n", { FAKE_LOGIN_PROMPT: "1" });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Choose an SSH key: ");
  });

  it("rejects an email that readiness and coding-agent commits reject", async () => {
    const result = await runLogin("Octo Owner\nfirst..last@example.com\n");

    expect(result.code).toBe(3);
    expect((await commands()).some((call) => call.command === "git" && call.args.includes("--replace-all"))).toBe(false);
  });

  it("passes the original SSH config snapshot into the atomic replacement", async () => {
    const source = await readFile(SCRIPT, "utf8");

    expect(source).toMatch(
      /writeOwnerFileAtomic\(configPath, `\$\{GITHUB_INCLUDE\}\\n\$\{text\}`, 0o600, CONFIG_BYTES, current\)/,
    );
  });

  it("rejects invalid identity before saving either value", async () => {
    const result = await runLogin(`${"x".repeat(201)}\nowner@example.com\n`);

    expect(result.code).toBe(3);
    expect((await commands()).some((call) => call.command === "git" && call.args.includes("--replace-all"))).toBe(false);
    expect(result.stderr).toBe("GitHub developer access setup could not be completed. Run the command again.\n");
  });

  it("stops on browser-login cancellation without leaking command output", async () => {
    const result = await runLogin("", { FAKE_CANCEL_LOGIN: "1" });

    expect(result.code).toBe(3);
    expect(await commands()).toEqual([{
      command: "gh",
      args: ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "ssh"],
    }]);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("ghp_secret_that_must_not_escape");
  });
});

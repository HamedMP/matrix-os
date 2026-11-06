import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const fixtureRoot = join(dirname(process.argv[1]), "..");
const fixture = JSON.parse(readFileSync(join(fixtureRoot, "fixture.json"), "utf8"));
appendFileSync(join(fixtureRoot, "commands.jsonl"), JSON.stringify({ command, args }) + "\\n");
if (fixture.FAKE_ENV_LOG) appendFileSync(fixture.FAKE_ENV_LOG, JSON.stringify({
  HOME: process.env.HOME, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
  GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
  GIT_EXEC_PATH: process.env.GIT_EXEC_PATH, GH_REPO: process.env.GH_REPO, GATEWAY_SECRET: process.env.GATEWAY_SECRET,
}) + "\\n");
if (command === "gh") {
  if (args[0] === "auth" && args[1] === "login") {
    if (fixture.FAKE_PRIVATE_KEY === "1") {
      process.stdout.write("-----BEGIN OPENSSH PRIVATE KEY-----\\n");
      await new Promise((resolveChunk) => setTimeout(resolveChunk, 20));
      process.stdout.write("c3ludGhldGljX3ByaXZhdGVfa2V5X2JvZHk=\\n");
      process.stdout.write("-----END OPENSSH PRIVATE KEY-----\\n");
      process.stderr.write("-----BEGIN RSA PRIVATE KEY-----\\n");
      process.stderr.write("c3ludGhldGljX3N0ZGVycl9rZXlfYm9keQ==");
      process.exit(130);
    }
    if (fixture.FAKE_CANCEL_LOGIN === "1") {
      console.error("cancelled ghp_secret_that_must_not_escape");
      process.exit(130);
    }
    if (fixture.FAKE_LOGIN_PROMPT === "1") {
      if (fixture.FAKE_TERMINAL_QUERY === "1") {
        process.stdout.write("\\u001b[?25l\\u001b7\\u001b[999;999f\\u001b[6n");
        await new Promise((resolveQuery) => {
          const timer = setTimeout(() => process.exit(13), 2_000);
          process.stdin.once("data", (input) => {
            if (input.toString() !== "\\u001b[24;80R") process.exit(14);
            clearTimeout(timer);
            resolveQuery();
          });
        });
      }
      const prompt = fixture.FAKE_PROMPT_TEXT || "Choose an SSH key: ";
      if (fixture.FAKE_SPLIT_PROMPT === "1") {
        process.stdout.write(prompt.slice(0, 11));
        await new Promise((resolveChunk) => setTimeout(resolveChunk, 30));
        process.stdout.write(prompt.slice(11));
      } else process.stdout.write(prompt);
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
  console.error("Hi " + (fixture.FAKE_SSH_LOGIN || "octocat") + "! You've successfully authenticated, but GitHub does not provide shell access.");
  process.exit(1);
}
if (command === "git") {
  const key = args.at(-1);
  if (args.includes("--get")) {
    if (fixture.FAKE_IDENTITY_READY === "1") {
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
    await writeFile(join(root, "fixture.json"), JSON.stringify(extraEnv));
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
      let queryAnswered = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (!queryAnswered && extraEnv.FAKE_TERMINAL_QUERY === "1" && stdout.includes("\u001b[6n")) {
          queryAnswered = true;
          child.stdin.write("\u001b[24;80R");
        }
        if (
          !promptAnswered
          && extraEnv.FAKE_LOGIN_PROMPT === "1"
          && stdout.includes(extraEnv.FAKE_PROMPT_TEXT || "Choose an SSH key: ")
        ) {
          promptAnswered = true;
          child.stdin.write("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", rejectRun);
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") rejectRun(error);
      });
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

  it.each([
    ["plain", "Press Enter to open https://github.com/login/device in your browser... ", "0"],
    ["split", "Press Enter to open https://github.com/login/device in your browser... ", "1"],
    ["ANSI", "\u001b[1mPress Enter\u001b[0m to open https://github.com/login/device in your browser... ", "1"],
  ])("shows the actual %s browser-wait prompt before accepting input", async (_kind, prompt, split) => {
    const result = await runLogin("\n\n", {
      FAKE_LOGIN_PROMPT: "1", FAKE_PROMPT_TEXT: prompt, FAKE_SPLIT_PROMPT: split,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(prompt);
  });

  it("refuses readiness and identity writes when SSH authenticates a different account", async () => {
    const result = await runLogin("\n\n", { FAKE_SSH_LOGIN: "other-owner" });
    expect(result.code).toBe(3);
    expect(result.stdout).not.toContain("developer access is ready");
    expect((await commands()).some((call) => call.command === "git" && call.args.includes("--replace-all"))).toBe(false);
  });

  it("forwards the real gh key-generation prompt when cursor controls share its chunk", async () => {
    const prompt = "\u001b[0G\u001b[2K\u001b[0;1;92m? \u001b[0m\u001b[0;1;99mGenerate a new SSH key to add to your GitHub account? \u001b[0m\u001b[0;39m(Y/n) \u001b[0m\u001b[?25l\u001b7\u001b[999;999f\u001b[6n";
    const result = await runLogin("\n\n", { FAKE_LOGIN_PROMPT: "1", FAKE_PROMPT_TEXT: prompt });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(prompt);
  });

  it("forwards a standalone terminal cursor query before gh waits for its report", async () => {
    const result = await runLogin("\n\n", { FAKE_LOGIN_PROMPT: "1", FAKE_TERMINAL_QUERY: "1" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("\u001b[999;999f\u001b[6n");
    expect(result.stdout).toContain("Choose an SSH key: ");
  });

  it("keeps token-bearing prompts buffered even when terminal controls follow them", async () => {
    const prompt = "Choose ghp_synthetic_secret: \u001b[?25l\u001b7\u001b[999;999f\u001b[6n";
    const result = await runLogin("", { FAKE_LOGIN_PROMPT: "1", FAKE_PROMPT_TEXT: prompt });
    expect(result.code).toBe(3);
    expect(result.stdout).not.toContain("ghp_synthetic_secret");
    expect(result.stdout).toContain("[redacted]");
  });

  it("uses owner files rather than inherited token, Git config or SSH command overrides", async () => {
    const environmentLog = join(root, "environment.jsonl");
    const result = await runLogin("\n\n", {
      FAKE_ENV_LOG: environmentLog, GH_TOKEN: "synthetic-token", GITHUB_TOKEN: "synthetic-token",
      GIT_SSH_COMMAND: "synthetic-command", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.email",
      GH_CONFIG_DIR: "/different-gh", GIT_CONFIG_GLOBAL: "/different-git",
      GIT_EXEC_PATH: "/different-git", GH_REPO: "another/repository", GATEWAY_SECRET: "synthetic-service-secret",
    });
    expect(result.code).toBe(0);
    const canonicalHome = await realpath(homePath);
    for (const line of (await readFile(environmentLog, "utf8")).trim().split("\n")) {
      expect(JSON.parse(line)).toEqual({ HOME: canonicalHome, GH_CONFIG_DIR: join(canonicalHome, ".config", "gh"), GIT_CONFIG_GLOBAL: join(canonicalHome, ".gitconfig") });
    }
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

  it("redacts multiline private-key bodies across chunks and an unterminated final line", async () => {
    const result = await runLogin("", { FAKE_PRIVATE_KEY: "1" });

    expect(result.code).toBe(3);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("c3ludGhldGljX3ByaXZhdGVfa2V5X2JvZHk=");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("c3ludGhldGljX3N0ZGVycl9rZXlfYm9keQ==");
    expect(result.stdout).toContain("[redacted private key]");
  });
});

import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
  if (args[0] === "auth" && args[1] === "status") {
    console.log(JSON.stringify({ hosts: fixture.FAKE_SETTINGS_EXISTING ? { "github.com": [{
      active: true, login: "octocat", state: "success", scopes: fixture.FAKE_SETTINGS_SCOPE || "repo, read:org"
    }] } : {} }));
    process.exit(0);
  }
  if (args[0] === "config" && args[1] === "set") process.exit(0);
  if (args[0] === "ssh-key" && args[1] === "add") {
    if (fixture.FAKE_SETTINGS_REGISTERED_KEY) process.exit(17);
    const input = readFileSync(0, "utf8");
    writeFileSync(join(fixtureRoot, "uploaded-key.txt"), input);
    process.exit(0);
  }
  if (fixture.FAKE_SETTINGS && args[0] === "auth" && ["login", "refresh"].includes(args[1])) {
    if (process.stdin.isTTY || process.env.GH_FORCE_TTY) process.exit(16);
    process.stderr.write("ignore ghp_fixture_secret\\n! First copy your one-time ");
    await new Promise((resolveChunk) => setTimeout(resolveChunk, 20));
    process.stderr.write("code: " + (fixture.FAKE_SETTINGS_BAD_CODE ? "ghp_fixture_not_a_device_code" : "ABCD-EF12") + "\\n");
    if (!fixture.FAKE_SETTINGS_NO_URL) {
      process.stderr.write("Open this URL to continue in your web browser: https://");
      await new Promise((resolveChunk) => setTimeout(resolveChunk, 20));
      process.stderr.write((fixture.FAKE_SETTINGS_BAD_URL ? "github.com/login/device/other" : "github.com/login/device") + "\\n");
    }
    if (fixture.FAKE_SETTINGS_CANCEL) await new Promise((resolve) => setTimeout(resolve, 10_000));
    process.exit(0);
  }
  if (args[0] === "auth" && args[1] === "login") {
    if (fixture.FAKE_REQUIRE_ACCESSIBLE_PROMPTER === "1" && process.env.GH_ACCESSIBLE_PROMPTER !== "1") {
      process.exit(15);
    }
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
if (command === "ssh-keygen") {
  const path = args[args.indexOf("-f") + 1];
  if (args[0] === "-y") {
    if (args[args.indexOf("-P") + 1] !== "") process.exit(18);
    const rejected = {
      "00-encrypted": "incorrect passphrase supplied to decrypt private key",
      "01-invalid": "invalid format",
      "00-inaccessible": "Permission denied",
    }[basename(path)];
    if (rejected) {
      console.error("Load key " + path + ": " + rejected);
      process.exit(255);
    }
    if (basename(path) === "02-mismatch") console.log("ssh-ed25519 T1RIRVI= derived comment");
    else process.stdout.write(readFileSync(path + ".pub", "utf8"));
    process.exit(0);
  }
  writeFileSync(path, "fixture private bytes", { flag: "wx", mode: 0o600 });
  writeFileSync(path + ".pub", "ssh-ed25519 R0VORVJBVEVE fixture generated key\\n", { flag: "wx", mode: 0o644 });
  process.exit(0);
}
if (command === "ssh") {
  let login = fixture.FAKE_SSH_LOGIN || "octocat";
  if (fixture.FAKE_SETTINGS_REGISTERED_KEY) {
    const selectedPath = args.includes("-i") ? args[args.indexOf("-i") + 1] : undefined;
    const config = readFileSync(join(process.env.HOME, ".ssh", "matrix-github.conf"), "utf8");
    if (selectedPath !== join(process.env.HOME, ".ssh", fixture.FAKE_SETTINGS_REGISTERED_KEY)
      && !config.includes("IdentityFile ~/.ssh/" + fixture.FAKE_SETTINGS_REGISTERED_KEY)) {
      console.error("git@github.com: Permission denied (publickey).");
      process.exit(255);
    }
    login = fixture.FAKE_SETTINGS_REGISTERED_LOGIN || login;
  } else if (fixture.FAKE_SETTINGS_NEEDS_KEY && !existsSync(join(fixtureRoot, "uploaded-key.txt"))) {
    console.error("git@github.com: Permission denied (publickey).");
    process.exit(255);
  }
  console.error("Hi " + login + "! You've successfully authenticated, but GitHub does not provide shell access.");
  process.exit(1);
}
if (command === "git") {
  const key = args.at(-1);
  if (args.includes("--get")) {
    if (fixture.FAKE_IDENTITY_READY === "1" || (fixture.FAKE_IDENTITY_NAME_READY && key === "user.name")) {
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
      symlink("fake-command.mjs", join(binPath, "ssh-keygen")),
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function runLogin(input = "", extraEnv: NodeJS.ProcessEnv = {}, settings = false): Promise<RunResult> {
    await writeFile(join(root, "fixture.json"), JSON.stringify(extraEnv));
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [SCRIPT, ...(settings ? ["--settings"] : [])], {
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
      if (settings) child.stdin.end();
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (extraEnv.FAKE_SETTINGS_CANCEL && stdout.includes("ABCD-EF12")) child.kill("SIGTERM");
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
      const inputTimer = settings ? undefined : setInterval(async () => {
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

  it("uses the accessible login prompter so cursor probing cannot hide the owner's question", async () => {
    const prompt = "Generate a new SSH key to add to your GitHub account? (Y/n): ";
    const result = await runLogin("\n\n", {
      FAKE_REQUIRE_ACCESSIBLE_PROMPTER: "1",
      FAKE_LOGIN_PROMPT: "1",
      FAKE_PROMPT_TEXT: prompt,
      GH_ACCESSIBLE_PROMPTER: "false",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(prompt);
    expect(result.stdout).toContain("GitHub developer access is ready for octocat.");
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
  it("runs unattended device authorization, exposes only the code and uploads the first valid key pair", async () => {
    const sshPath = join(homePath, ".ssh");
    await mkdir(sshPath, { mode: 0o700 });
    await writeFile(join(sshPath, "00-orphan.pub"), "ssh-ed25519 T1JQSEFO\n");
    for (const [name, key] of [["b-later", "TEFURVI="], ["a-first", "RklSU1Q="]]) {
      await writeFile(join(sshPath, name), "fixture private bytes", { mode: 0o600 });
      await writeFile(join(sshPath, `${name}.pub`), `ssh-ed25519 ${key} test comment\n`);
    }
    const result = await runLogin("", {
      FAKE_SETTINGS: "1", FAKE_SETTINGS_NEEDS_KEY: "1", FAKE_IDENTITY_NAME_READY: "1", GH_FORCE_TTY: "1",
    }, true);
    expect(result).toEqual({ code: 0, stdout: '{"deviceCode":"ABCD-EF12"}\n', stderr: "" });
    await expect(readFile(join(root, "uploaded-key.txt"), "utf8")).resolves.toBe("ssh-ed25519 RklSU1Q=\n");
    await expect(readFile(join(sshPath, "matrix-github.conf"), "utf8")).resolves.toContain("IdentityFile ~/.ssh/a-first");
    const calls = await commands();
    expect(calls).toContainEqual({ command: "gh", args: expect.arrayContaining(["auth", "login", "--web", "--skip-ssh-key", "admin:public_key"]) });
    expect(calls.filter((call) => call.command === "git" && call.args.includes("--replace-all"))).toEqual([{
      command: "git", args: ["config", "--global", "--replace-all", "user.email", "583231+octocat@users.noreply.github.com"],
    }]);
  });

  it("refreshes the active account for key registration and generates a key without replacing owner keys", async () => {
    const result = await runLogin("", { FAKE_SETTINGS: "1", FAKE_SETTINGS_EXISTING: "1", FAKE_SETTINGS_NEEDS_KEY: "1" }, true);
    expect(result.code).toBe(0);
    const calls = await commands();
    expect(calls).toContainEqual({ command: "gh", args: ["auth", "refresh", "--hostname", "github.com", "--scopes", "admin:public_key"] });
    expect(calls.some((call) => call.command === "gh" && call.args[1] === "login")).toBe(false);
    expect(calls.some((call) => call.command === "ssh-keygen")).toBe(true);
    await expect(readFile(join(root, "uploaded-key.txt"), "utf8")).resolves.toBe("ssh-ed25519 R0VORVJBVEVE\n");
  });

  it.each([true, false])("skips keys unsuitable for unattended SSH, with an alternative key: %s", async (hasAlternative) => {
    const sshPath = join(homePath, ".ssh");
    await mkdir(sshPath, { mode: 0o700 });
    const unsuitable = ["00-encrypted", "01-invalid", "02-mismatch"];
    for (const name of [...unsuitable, ...(hasAlternative ? ["03-unattended"] : [])]) {
      await writeFile(join(sshPath, name), "fixture private bytes", { mode: 0o600 });
      await writeFile(join(sshPath, `${name}.pub`), `ssh-ed25519 ${name === "03-unattended" ? "VU5BVFRFTkRFRA==" : "VU5TVUlUQUJMRQ=="}\n`);
    }
    const result = await runLogin("", {
      FAKE_SETTINGS: "1", FAKE_SETTINGS_EXISTING: "1", FAKE_SETTINGS_NEEDS_KEY: "1", FAKE_SETTINGS_SCOPE: "admin:public_key",
    }, true);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    const expectedBlob = hasAlternative ? "VU5BVFRFTkRFRA==" : "R0VORVJBVEVE";
    await expect(readFile(join(root, "uploaded-key.txt"), "utf8")).resolves.toBe(`ssh-ed25519 ${expectedBlob}\n`);
    const config = await readFile(join(sshPath, "matrix-github.conf"), "utf8");
    expect(config).toContain(`IdentityFile ~/.ssh/${hasAlternative ? "03-unattended" : "matrix-github/id_ed25519"}`);
    const derived = (await commands()).filter(({ command, args }) => command === "ssh-keygen" && args[0] === "-y");
    expect(derived.map(({ args }) => basename(args.at(-1)!))).toEqual([
      ...unsuitable, hasAlternative ? "03-unattended" : "id_ed25519",
    ]);
  });

  it("does not upload or generate a key after a hard key derivation failure", async () => {
    const sshPath = join(homePath, ".ssh");
    await mkdir(sshPath, { mode: 0o700 });
    await writeFile(join(sshPath, "00-inaccessible"), "fixture private bytes", { mode: 0o600 });
    await writeFile(join(sshPath, "00-inaccessible.pub"), "ssh-ed25519 RklSU1Q=\n");
    const result = await runLogin("", {
      FAKE_SETTINGS: "1", FAKE_SETTINGS_EXISTING: "1", FAKE_SETTINGS_NEEDS_KEY: "1", FAKE_SETTINGS_SCOPE: "admin:public_key",
    }, true);
    expect(result).toEqual({ code: 3, stdout: "", stderr: "" });
    expect((await commands()).some(({ command, args }) => (command === "gh" && args[0] === "ssh-key")
      || (command === "ssh-keygen" && args[0] !== "-y"))).toBe(false);
  });

  it.each(["octocat", "other-owner"])("checks the selected registered key for %s before persisting it", async (login) => {
    const sshPath = join(await realpath(homePath), ".ssh");
    const name = "a-registered-key";
    await mkdir(sshPath, { mode: 0o700 });
    await writeFile(join(sshPath, name), "fixture private bytes", { mode: 0o600 });
    await writeFile(join(sshPath, `${name}.pub`), "ssh-ed25519 RklSU1Q=\n");
    const result = await runLogin("", {
      FAKE_SETTINGS: "1", FAKE_SETTINGS_EXISTING: "1",
      FAKE_SETTINGS_REGISTERED_KEY: name, FAKE_SETTINGS_REGISTERED_LOGIN: login,
    }, true);
    const matchesAccount = login === "octocat";
    expect(result).toEqual({ code: matchesAccount ? 0 : 3, stdout: "", stderr: "" });
    const calls = await commands();
    expect(calls).toContainEqual({ command: "ssh", args: expect.arrayContaining([
      "-F", "/dev/null", "-i", join(sshPath, name), "IdentitiesOnly=yes", "IdentityAgent=none",
      "CertificateFile=none", "StrictHostKeyChecking=yes", `UserKnownHostsFile=${join(sshPath, "matrix-github-known-hosts")}`,
    ]) });
    expect(calls.some(({ command, args }) => command === "gh" && (args[0] === "ssh-key" || args[1] === "refresh"))).toBe(false);
    const config = await readFile(join(sshPath, "matrix-github.conf"), "utf8");
    expect(config.includes(`IdentityFile ~/.ssh/${name}`)).toBe(matchesAccount);
  });

  it("reuses matching SSH for an existing active account without browser authorization or uploading a key", async () => {
    const result = await runLogin("", { FAKE_SETTINGS: "1", FAKE_SETTINGS_EXISTING: "1", FAKE_IDENTITY_READY: "1" }, true);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    const calls = await commands();
    expect(calls.some((call) => call.command === "gh" && ["login", "refresh", "add"].includes(call.args[1] ?? ""))).toBe(false);
  });

  it("cancels the Settings subprocess before SSH or identity work", async () => {
    const result = await runLogin("", { FAKE_SETTINGS: "1", FAKE_SETTINGS_CANCEL: "1" }, true);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('{"deviceCode":"ABCD-EF12"}\n');
    expect((await commands()).map(({ command, args }) => [command, ...args.slice(0, 2)])).toEqual([
      ["gh", "auth", "status"], ["gh", "auth", "login"],
    ]);
  });

  it("refuses an SSH account mismatch before uploading a key or changing identity", async () => {
    const result = await runLogin("", { FAKE_SETTINGS: "1", FAKE_SETTINGS_EXISTING: "1", FAKE_SSH_LOGIN: "other-owner" }, true);
    expect(result).toEqual({ code: 3, stdout: "", stderr: "" });
    const calls = await commands();
    expect(calls.some(({ command, args }) => command === "git" || args[0] === "ssh-key")).toBe(false);
  });

  it.each([
    "FAKE_SETTINGS_BAD_CODE",
    "FAKE_SETTINGS_BAD_URL",
    "FAKE_SETTINGS_NO_URL",
  ])("rejects invalid or incomplete device authorization output (%s)", async (fixtureFlag) => {
    const result = await runLogin("", { FAKE_SETTINGS: "1", [fixtureFlag]: "1" }, true);
    expect(result).toEqual({ code: 3, stdout: "", stderr: "" });
    expect((await commands()).map(({ command, args }) => [command, ...args.slice(0, 2)])).toEqual([
      ["gh", "auth", "status"], ["gh", "auth", "login"],
    ]);
  });

});

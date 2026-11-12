import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = resolve("packages/sync-client/bin/matrix.mjs");
const worktree = "/src/matrix-demo";
const computer = "my-dev";
const previewUrl = "https://preview.example.test/vm/stage2-demo/";
const newWorktree = "/src/matrix-second";
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "matrix-devstack-cli-"));
  await mkdir(join(home, ".matrixos"), { mode: 0o700 });
  await installAdapter();
});

async function installAdapter(options: {
  v2?: boolean;
  ambiguous?: boolean;
  discoverFails?: boolean;
  boundWorktree?: string;
} = {}) {
  await writeFile(join(home, ".matrixos", "devstack-adapter"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(home, "calls"))}, JSON.stringify(args) + "\\n");
const options = ${JSON.stringify(options)};
const binding = { computer: "${computer}", worktree: options.boundWorktree ?? "${worktree}" };
const newBinding = { computer: "${computer}", worktree: "${newWorktree}" };
const marker = ${JSON.stringify(join(home, "enrolled"))};
const preview = { previewUrl: "${previewUrl}", syncScope: ["shell/src/example.tsx"] };
const print = value => console.log(JSON.stringify(value));
switch (args[0]) {
  case "list":
    print([binding, ...(options.ambiguous ? [{ ...binding, computer: "another-dev" }] : []),
      ...(fs.existsSync(marker) ? [newBinding] : [])]);
    break;
  case "discover":
    if (options.discoverFails) {
      console.error("private adapter diagnostic");
      process.exitCode = 1;
    } else if (options.v2) {
      print([binding, newBinding]);
    } else {
      console.error("This Computer and worktree are not enrolled.");
      process.exitCode = 1;
    }
    break;
  case "enroll":
    fs.writeFileSync(marker, "1");
    print(preview);
    break;
  case "connect":
    print(preview);
    break;
  case "sync":
  case "reset":
    print({ syncScope: preview.syncScope });
    break;
  case "status":
    print({ state: "ready", previewUrl: preview.previewUrl, unsafeField: "never print me" });
    break;
  case "diff":
    print({ changes: [{ path: "shell/src/example.tsx", status: "M" }], excluded: [".env.local"] });
    break;
}
`, { mode: 0o700 });
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function run(...args: string[]) {
  return runFrom(undefined, ...args);
}

function runFrom(cwd: string | undefined, ...args: string[]) {
  return exec(process.execPath, [cli, "devstack", ...args], {
    cwd,
    env: { ...process.env, HOME: home, MATRIX_NO_TELEMETRY: "1" },
    timeout: 8_000,
  });
}

async function calls() {
  return (await readFile(join(home, "calls"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

describe("matrix devstack", () => {
  it("connects the selected pair and returns the authenticated preview link as JSON", async () => {
    const { stdout } = await run("--computer", computer, "--worktree", worktree, "--json");
    expect(JSON.parse(stdout)).toEqual({ v: 1, ok: true, data: {
      computer, worktree, previewUrl: "https://preview.example.test/vm/stage2-demo/",
      syncScope: ["shell/src/example.tsx"],
    } });
    expect(await calls()).toEqual([["list"], ["connect", computer, worktree, "link"]]);
  });

  it("rejects an unbound Computer before connecting or syncing", async () => {
    await expect(run("--computer", "my-main", "--worktree", worktree, "--json"))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("devstack_binding_not_found") });
    expect(await calls()).toEqual([["list"], ["discover", worktree]]);
  });

  it("rejects an unbound worktree even for a bound Dev Computer", async () => {
    await expect(run("--computer", computer, "--worktree", "/src/other", "--json"))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("devstack_binding_not_found") });
    expect(await calls()).toEqual([["list"], ["discover", "/src/other"]]);
  });

  it("enrolls an eligible unbound worktree and reconnects without a second claim", async () => {
    await installAdapter({ v2: true });
    const args = ["--computer", computer, "--worktree", newWorktree, "--json"];
    for (const { stdout } of [await run(...args), await run(...args)]) {
      expect(JSON.parse(stdout).data).toMatchObject({ computer, worktree: newWorktree, previewUrl });
    }
    expect(await calls()).toEqual([
      ["list"], ["discover", newWorktree], ["enroll", computer, newWorktree, "link"],
      ["list"], ["connect", computer, newWorktree, "link"],
    ]);
  });

  it("fails closed when discovery encounters an adapter error", async () => {
    await installAdapter({ v2: true, discoverFails: true });
    await expect(run("--computer", computer, "--worktree", newWorktree, "--json"))
      .rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(/^(?!.*private adapter diagnostic).*devstack_adapter_failed/),
      });
    expect(await calls()).toEqual([["list"], ["discover", newWorktree]]);
  });

  it.each([
    ["sync", { syncScope: ["shell/src/example.tsx"] }],
    ["reset", { syncScope: ["shell/src/example.tsx"] }],
    ["status", { state: "ready", previewUrl }],
    ["diff", { changes: [{ path: "shell/src/example.tsx", status: "M" }], excluded: [".env.local"] }],
  ] as const)("runs %s on only the bound worktree and emits validated JSON", async (operation, expected) => {
    const { stdout } = await run(operation, "--worktree", worktree, "--json");
    expect(JSON.parse(stdout)).toEqual({ v: 1, ok: true, data: { computer, worktree, ...expected } });
    expect(await calls()).toEqual([["list"], [operation, computer, worktree]]);
  });

  it("resolves the current Git worktree even from a nested directory", async () => {
    const repo = join(await realpath(home), "repo");
    const nested = join(repo, "shell", "src");
    await mkdir(nested, { recursive: true });
    await exec("git", ["init", "--quiet", repo]);
    await installAdapter({ boundWorktree: repo });
    const { stdout } = await runFrom(nested, "status", "--json");
    expect(JSON.parse(stdout).data).toMatchObject({ computer, worktree: repo, state: "ready" });
    expect(await calls()).toEqual([["list"], ["status", computer, repo]]);
  });

  it("rejects terminal control characters in discovered worktree paths", async () => {
    await installAdapter({ boundWorktree: "/src/unsafe\u009b31m" });
    await expect(run("status", "--worktree", worktree, "--json"))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("devstack_adapter_failed") });
    expect(await calls()).toEqual([["list"]]);
  });

  it("never executes an owner-only adapter from a directory writable by other users", async () => {
    await chmod(join(home, ".matrixos"), 0o777);
    await expect(run("status", "--worktree", worktree, "--json"))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("devstack_adapter_unavailable") });
    await expect(readFile(join(home, "calls"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });

  it("requires a Computer when a worktree is bound to more than one", async () => {
    await installAdapter({ ambiguous: true });
    await expect(run("reset", "--worktree", worktree, "--json"))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("devstack_selection_required") });
    expect(await calls()).toEqual([["list"]]);
  });

  it("does not enroll a worktree from a lifecycle subcommand", async () => {
    await installAdapter({ v2: true });
    await expect(run("reset", "--computer", computer, "--worktree", newWorktree, "--json"))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("devstack_binding_not_found") });
    expect(await calls()).toEqual([["list"]]);
  });

  it("retains a target flag passed before a lifecycle subcommand", async () => {
    await installAdapter({ ambiguous: true });
    const { stdout } = await run("--computer", "another-dev", "reset", "--worktree", worktree, "--json");
    expect(JSON.parse(stdout).data.computer).toBe("another-dev");
    expect(await calls()).toEqual([["list"], ["reset", "another-dev", worktree]]);
  });
});

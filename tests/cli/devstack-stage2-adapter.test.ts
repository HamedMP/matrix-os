import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const adapter = resolve("scripts/devstack/stage2-worktrees.mjs");
const mutagen = process.env.DEVSTACK_TEST_MUTAGEN;
const flock = process.env.DEVSTACK_TEST_FLOCK;

it.skipIf(!mutagen || !flock)("enrolls, watches and operates two independent Mutagen worktrees", async () => {
  const root = await realpath(await mkdtemp("/tmp/matrix-stage2-adapter-"));
  const repo = join(root, "repo");
  const state = join(root, "state");
  const guard = join(root, "guard");
  const conf = join(root, "config.json");
  const a = join(root, "worktree a");
  const b = join(root, "worktree b");
  const alpha = join(root, "receiver-a");
  const beta = join(root, "receiver-b");
  const env = { ...process.env, MUTAGEN_DATA_DIRECTORY: join(state, "mutagen"), HOME: state };
  const calls = (action: string, ...args: string[]) => exec(process.execPath, [adapter, conf, action, ...args], { timeout: 30_000 });
  const git = (worktree: string, ...args: string[]) => exec("git", ["-C", worktree, ...args]);
  const source = "src/main.txt";
  const waitFor = async (path: string, expected: string) => {
    for (let attempt = 0; attempt < 70; attempt++) {
      if (await readFile(path, "utf8").catch(() => "") === expected) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    expect(await readFile(path, "utf8")).toBe(expected);
  };

  try {
    await mkdir(repo);
    await mkdir(alpha);
    await mkdir(beta);
    await git(repo, "init", "--quiet");
    await git(repo, "config", "user.email", "devstack-test@example.invalid");
    await git(repo, "config", "user.name", "DevStack Test");
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, source), "base");
    await writeFile(join(repo, ".gitignore"), ".env\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "--quiet", "-m", "fixture");
    await git(repo, "worktree", "add", "--detach", a);
    await git(repo, "worktree", "add", "--detach", b);
    await writeFile(guard, `#!${process.execPath}
const [verb, slot, transaction, payload] = process.argv.slice(2);
if (!["a","b"].includes(slot)) process.exit(1);
if (verb === "preview") console.log("https://preview.example.test/vm/" + slot + "/");
if (verb === "repair") {
  const fs = require("node:fs");
  const {createHash} = require("node:crypto");
  const [file, ...remaining] = JSON.parse(payload);
  if (slot !== "a" || remaining.length || file.path !== "src/main.txt") process.exit(1);
  const source = ${JSON.stringify(join(alpha, "src/main.txt"))};
  if (createHash("sha1").update(fs.readFileSync(source)).digest("hex") !== file.digest) process.exit(1);
  fs.renameSync(source, ${JSON.stringify(join(root, "remote-backup"))});
}
`, { mode: 0o700 });
    await chmod(guard, 0o700);
    await writeFile(conf, JSON.stringify({
      computer: "dev-fixture", state, repository: repo, guard, mutagen, flock, sshShim: root,
      previewOrigin: "https://preview.example.test",
      slots: [{ id: "a", endpoint: alpha, previewPath: "/vm/a/" },
        { id: "b", endpoint: beta, previewPath: "/vm/b/" }],
    }), { mode: 0o600 });
    expect(JSON.parse((await calls("discover", a)).stdout)).toEqual([{ computer: "dev-fixture", worktree: a }]);
    const enrollA = await calls("enroll", "dev-fixture", a, "link");
    const enrollB = await calls("enroll", "dev-fixture", b, "link");
    expect(JSON.parse(enrollA.stdout).previewUrl).toBe("https://preview.example.test/vm/a/");
    expect(JSON.parse(enrollB.stdout).previewUrl).toBe("https://preview.example.test/vm/b/");
    expect(JSON.parse((await calls("enroll", "dev-fixture", a, "link")).stdout)).toEqual(JSON.parse(enrollA.stdout));
    await writeFile(join(a, source), "dirty A");
    await writeFile(join(a, "src/new.txt"), "only A");
    await writeFile(join(a, ".env"), "must not sync");
    await writeFile(join(b, source), "dirty B");
    await Promise.all([waitFor(join(alpha, source), "dirty A"), waitFor(join(beta, source), "dirty B")]);
    await waitFor(join(alpha, "src/new.txt"), "only A");
    await expect(readFile(join(beta, "src/new.txt"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(readFile(join(alpha, ".env"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(readFile(join(alpha, ".git"))).rejects.toHaveProperty("code", "ENOENT");
    expect(JSON.parse((await calls("diff", "dev-fixture", a)).stdout).changes).toEqual(
      expect.arrayContaining([{ path: source, status: " M" }, { path: "src/new.txt", status: "??" }]),
    );
    await calls("sync", "dev-fixture", a);
    await writeFile(join(alpha, source), "remote drift");
    await calls("reset", "dev-fixture", a);
    expect((await readFile(join(a, source), "utf8"))).toBe("dirty A");
    expect((await readFile(join(alpha, source), "utf8"))).toBe("dirty A");
    expect((await readFile(join(root, "remote-backup"), "utf8"))).toBe("remote drift");
    expect((await readFile(join(beta, source), "utf8"))).toBe("dirty B");
    expect(JSON.parse((await calls("status", "dev-fixture", b)).stdout).state).toBe("ready");
    await expect(calls("sync", "wrong-dev", a)).rejects.toHaveProperty("code", 1);
  } finally {
    for (const slot of ["a", "b"]) {
      const owner = await readFile(join(state, slot, "watcher.json"), "utf8").then(JSON.parse).catch(() => null);
      if (Number.isInteger(owner?.pid)) {
        try { process.kill(owner.pid, "SIGTERM"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    if (mutagen) await exec(mutagen, ["daemon", "stop"], { env, timeout: 5_000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 55_000);

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = resolve("packages/sync-client/bin/matrix.mjs");
const origin = "https://devstack.matrix-os.com";
const approvalId = "a".repeat(43);
const pollSecret = "p".repeat(43);
const bearer = "b".repeat(43);
let home: string;
let repo: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "matrix-devstack-hosted-"));
  repo = join(home, "checkout");
  await exec("git", ["init", "--quiet", repo]);
  await writeFile(join(home, "fixture.mjs"), `
    import { appendFileSync } from "node:fs";
    let sourceIdentity;
    let polls = 0;
    globalThis.fetch = async (url, options) => {
      const { pathname, origin } = new URL(url);
      const input = JSON.parse(options.body);
      appendFileSync(${JSON.stringify(join(home, "requests"))}, JSON.stringify({
        origin, pathname, input, method: options.method, redirect: options.redirect,
        authorization: new Headers(options.headers).get("authorization"),
      }) + "\\n");
      if (pathname === "/devstack/cli/pair") {
        sourceIdentity = input.sourceIdentity;
        return Response.json({
          approvalId: ${JSON.stringify(approvalId)}, pollSecret: ${JSON.stringify(pollSecret)}, expiresAt: Date.now() + 60_000,
          ...(process.env.DEVSTACK_TEST_APPROVAL_ORIGIN ? { approvalOrigin: process.env.DEVSTACK_TEST_APPROVAL_ORIGIN } : {}),
        }, { status: 201 });
      }
      if (pathname === "/devstack/cli/poll") {
        if (++polls === 1 && process.env.DEVSTACK_TEST_PENDING === "1") return new Response(null, { status: 202 });
        return Response.json({
          bearer: ${JSON.stringify(bearer)}, expiresAt: Date.now() + 60_000,
          binding: {
            runtime: "dev-linux", worktree: "feature-one",
            ...(process.env.DEVSTACK_TEST_SYNC_CAPABLE === "1" ? { sourceSync: true } : {}),
            sourceIdentity: process.env.DEVSTACK_TEST_WRONG_TREE === "1" ? "f".repeat(64) : sourceIdentity,
          },
        });
      }
      if (pathname === "/devstack/cli/source") {
        const revision = "e".repeat(64);
        return Response.json({ revision, files: 1, updated: 1, removed: 0,
          test: { revision, exitCode: 0, log: "4 tests passed" } });
      }
      return new Response(null, { status: 404 });
    };
  `);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function run(cwd: string, args: string[] = [], env: Record<string, string> = {}) {
  const fixture = pathToFileURL(join(home, "fixture.mjs")).href;
  return exec(process.execPath, ["--import", fixture, cli, "devstack", "--json", ...args], {
    cwd,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, MATRIX_NO_TELEMETRY: "1",
      MATRIXOS_TOKEN: "unrelated-main-token", NODE_OPTIONS: `--import=${fixture}`, ...env,
    },
    timeout: 15_000,
  });
}

async function requests() {
  return (await readFile(join(home, "requests"), "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
}

describe("hosted matrix devstack", () => {
  it("opens the separate trusted approval origin while keeping poll and source on the hosted origin", async () => {
    const approvalOrigin = 'https://devstack-approve.example.test';
    const { stderr } = await run(repo, [], { DEVSTACK_TEST_APPROVAL_ORIGIN: approvalOrigin });
    expect(stderr).toContain(`${approvalOrigin}/devstack/cli/pair/${approvalId}`);
    expect((await requests()).every(request => request.origin === origin)).toBe(true);
    await expect(run(repo, [], { DEVSTACK_TEST_APPROVAL_ORIGIN: 'https://user:secret@untrusted.test/path' }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('devstack_pairing_invalid') });
  });
  it("pairs the current Git checkout and returns the approved stable preview with no credentials in output", async () => {
    const nested = join(repo, "shell", "src");
    await mkdir(nested, { recursive: true });
    const { stdout, stderr } = await run(nested, [], { DEVSTACK_TEST_PENDING: "1" });
    expect(JSON.parse(stdout)).toEqual({
      v: 1, ok: true, data: {
        computer: "dev-linux", worktree: "feature-one", state: "connected",
        entryUrl: `${origin}/devstack/worktrees/feature-one/`,
      },
    });
    expect(stderr).toContain(`${origin}/devstack/cli/pair/${approvalId}`);
    const [pairRequest] = await requests();
    expect(stderr).toContain(`Worktree fingerprint: ${pairRequest.input.sourceIdentity.slice(0, 12)}`);
    expect(stdout + stderr).not.toContain(pollSecret);
    expect(stdout + stderr).not.toContain(bearer);
    expect(await requests()).toEqual([
      { origin, pathname: "/devstack/cli/pair", method: "POST", redirect: "error", authorization: null,
        input: { sourceIdentity: expect.stringMatching(/^[0-9a-f]{64}$/) } },
      ...[1, 2].map(() => ({
        origin, pathname: "/devstack/cli/poll", method: "POST", redirect: "error", authorization: null,
        input: { pollSecret },
      })),
    ]);
  });

  it("syncs a real uncommitted source edit and returns a correlated test receipt", async () => {
    await writeFile(join(repo, "example.txt"), "baseline");
    await exec("git", ["-C", repo, "add", "example.txt"]);
    await exec("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "commit", "--quiet", "-m", "Baseline"]);
    await writeFile(join(repo, "example.txt"), "uncommitted");
    const { stdout, stderr } = await run(repo, [], { DEVSTACK_TEST_SYNC_CAPABLE: "1" });
    const revision = "e".repeat(64);
    expect(JSON.parse(stdout).data).toMatchObject({
      worktree: "feature-one", state: "synced", revision, test: { revision, exitCode: 0, log: "4 tests passed" },
    });
    expect(stdout + stderr).not.toContain(bearer);
    expect((await requests()).at(-1)).toMatchObject({
      origin, pathname: "/devstack/cli/source", authorization: "Bearer " + bearer,
      input: { base: expect.stringMatching(/^[a-f0-9]{40}$/), entries: [
        { path: "example.txt", kind: "file", mode: 420, content: Buffer.from("uncommitted").toString("base64") },
      ] },
    });
  });

  it("reports a missing hosted publisher without uploading source", async () => {
    await expect(run(repo, ["sync", "--hosted"])).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("devstack_source_unavailable"),
    });
    expect((await requests()).map(request => request.pathname)).toEqual(["/devstack/cli/pair", "/devstack/cli/poll"]);
  });

  it("refuses to send source to another HTTPS origin", async () => {
    await expect(run(repo, ["sync", "--hosted", "--platform", "https://elsewhere.example.test"]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("devstack_invalid_origin") });
    await expect(requests()).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects a hosted command outside Git before contacting the service", async () => {
    const outside = join(home, "outside");
    await mkdir(outside);
    await expect(run(outside, ["--hosted"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Run `matrix devstack` from the Git worktree you want to connect."),
    });
    await expect(requests()).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects approval for a different checkout without exposing the granted bearer", async () => {
    const result = await run(repo, [], { DEVSTACK_TEST_WRONG_TREE: "1" }).catch((error: unknown) => error);
    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("devstack_pairing_invalid"),
    });
    expect((result as { stderr: string }).stderr).not.toContain(bearer);
  });

  it("preserves default Stage 2 selection with an enrolled adapter and supports an explicit hosted override", async () => {
    const config = join(home, ".matrixos");
    await mkdir(config, { mode: 0o700 });
    await writeFile(join(config, "devstack-adapter"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await expect(run(repo)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Use --computer <handle> and --worktree <path>."),
    });
    await expect(requests()).rejects.toHaveProperty("code", "ENOENT");
    await run(repo, ["--hosted", "--platform", "https://devstack.example.test"]);
    expect((await requests()).map(request => request.origin)).toEqual(Array(2).fill("https://devstack.example.test"));
  });

  it("keeps checkout identity stable across edits and distinct across linked worktrees", async () => {
    await exec("git", ["-C", repo, "-c", "user.name=DevStack", "-c", "user.email=devstack@example.test",
      "commit", "--allow-empty", "--quiet", "-m", "fixture"]);
    const linked = join(home, "linked-worktree");
    await exec("git", ["-C", repo, "worktree", "add", "--quiet", "--detach", linked]);

    await run(repo);
    await writeFile(join(repo, "uncommitted.txt"), "one");
    await run(repo);
    await run(linked);
    const fingerprints = (await requests()).filter(request => request.pathname === "/devstack/cli/pair")
      .map(request => request.input.sourceIdentity);
    expect(fingerprints).toHaveLength(3);
    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect(fingerprints[2]).not.toBe(fingerprints[0]);
  });
});

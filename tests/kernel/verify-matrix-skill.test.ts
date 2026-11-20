import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(__dirname, "../..");
const root = join(repo, ".agents/skills/verify-matrix");
const cli = join(root, "scripts/matrix-verify");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const readRepo = (file: string) => readFileSync(join(repo, file), "utf8");

function runCli(args: string[], verifyRoot: string) {
  return spawnSync(cli, args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, MATRIX_VERIFY_ROOT: verifyRoot },
    timeout: 20_000,
  });
}

describe("verify-matrix skill", () => {
  it("is a team skill shared by Claude Code and Codex, not shipped to customer computers", () => {
    expect(existsSync(join(repo, "skills/matrix/verify-matrix"))).toBe(false);
    for (const file of ["scripts/install-agent-matrix-skills.sh", "scripts/install-hermes-matrix-skills.sh"]) {
      expect(readRepo(file), file).not.toMatch(/verify-matrix/);
    }
    const ignore = readRepo(".gitignore");
    expect(ignore).toMatch(/^!\.agents\/skills\/verify-matrix\/\*\*$/m);
    expect(ignore).toMatch(/^!\.claude\/skills\/verify-matrix$/m);
    expect(readFileSync(join(repo, ".claude/skills/verify-matrix/SKILL.md"), "utf8")).toBe(read("SKILL.md"));
  });

  it("registers with frontmatter naming the app, surface, and when to use it", () => {
    const lines = read("SKILL.md").split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe("name: verify-matrix");
    expect(lines[2]).toMatch(/^description: .*Matrix OS.*Web Desktop.*/);
    for (const section of ["Launch", "Doctor", "Drive", "Evidence", "Cleanup"]) {
      expect(read("SKILL.md")).toMatch(new RegExp(`^## ${section}$`, "m"));
    }
  });

  it("ships executable helpers whose invocation the skill shows", () => {
    for (const script of ["scripts/matrix-verify", "scripts/drive.mjs"]) {
      expect(() => accessSync(join(root, script), constants.X_OK), script).not.toThrow();
    }
    expect(read("SKILL.md")).toContain("$V launch");
    expect(execFileSync(cli, ["--help"], { encoding: "utf8" })).toMatch(/launch .*doctor .*drive .*stop/s);
  });

  it("keeps evidence and scratch state outside the repo", () => {
    expect(read("scripts/matrix-verify")).toContain('ROOT="${MATRIX_VERIFY_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/matrix-verify}"');
    expect(read("SKILL.md")).toMatch(/never commit captures/i);
  });

  it("refuses to launch on a port another instance already owns", async () => {
    const verifyRoot = mkdtempSync(join(tmpdir(), "verify-matrix-test-"));
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    try {
      const result = runCli(["launch", "--run", "busy", "--gateway-port", String(port), "--skip-build"], verifyRoot);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`port ${port} is already in use`));
      expect(existsSync(join(verifyRoot, "runs/busy"))).toBe(false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(verifyRoot, { recursive: true, force: true });
    }
  });

  it("does not doctor, drive, or stop a run it did not start", () => {
    const verifyRoot = mkdtempSync(join(tmpdir(), "verify-matrix-test-"));
    try {
      for (const args of [["doctor"], ["stop"], ["doctor", "--run", "someone-else"]]) {
        const result = runCli(args, verifyRoot);
        expect(result.status, args.join(" ")).toBe(1);
        expect(result.stderr).toMatch(/no runs found|unknown run/);
      }
    } finally {
      rmSync(verifyRoot, { recursive: true, force: true });
    }
  });

  it("keeps every feature file on the four-section map contract", () => {
    const features = readdirSync(join(root, "features")).filter((f) => f.endsWith(".md") && f !== "README.md");
    expect(features.length).toBeGreaterThanOrEqual(3);
    const index = read("features/README.md");
    for (const file of features) {
      expect(index, `${file} missing from README index`).toContain(`(./${file})`);
      const headings = read(`features/${file}`).match(/^## .+$/gm);
      expect(headings, file).toEqual([
        "## Sub-features",
        "## How to get to it (user POV)",
        "## Driving it with matrix-verify",
        "## Gotchas",
      ]);
    }
    for (const journey of readdirSync(join(root, "features/journeys"))) {
      expect(index + read("features/files.md"), journey).toContain(journey);
    }
  });
});

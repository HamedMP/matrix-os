import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Each case drives the real entrypoint (check-patterns.sh) against a throwaway
// git repo whose origin/main holds `base` and whose branch adds `change`.
const scanner = join(process.cwd(), "scripts/review/check-patterns.sh");
const repos: string[] = [];

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function scanChange(
  base: Record<string, string>,
  change: Record<string, string>,
  {
    commit = true,
    args = ["--diff", "origin/main"],
    rename,
  }: { commit?: boolean; args?: string[]; rename?: [string, string] } = {},
) {
  const repo = mkdtempSync(join(tmpdir(), "matrix-added-patterns-"));
  repos.push(repo);
  git(repo, ["init", "-q", "-b", "work"]);
  git(repo, ["config", "user.email", "ci@example.com"]);
  git(repo, ["config", "user.name", "CI"]);
  writeFiles(repo, { "README.md": "fixture\n", ...base });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  if (rename) git(repo, ["mv", ...rename]);
  writeFiles(repo, change);
  if (commit) {
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "change"]);
  }
  return spawnSync("bash", [scanner, ...args], { cwd: repo, encoding: "utf8", timeout: 20_000 });
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("added-line swallowed-error rule", () => {
  it("rejects the bare catch #3093 added to a script outside packages/ and shell/", () => {
    const result = scanChange({}, {
      "scripts/build-node-pty.mjs": [
        "try {",
        "  require('node-pty');",
        "} catch {",
        "  console.error('[build-node-pty] rebuilt native module failed to load');",
        "  process.exit(1);",
        "}",
      ].join("\n"),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("VIOLATION [swallowed-error] scripts/build-node-pty.mjs:3: catch without a binding drops the error");
  });

  it("rejects the empty rejection handler #3083 added to a test helper", () => {
    const result = scanChange({}, {
      "tests/gateway/native-control-owned-bootstrap.mjs":
        "exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});exit.catch(()=>{});\n",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("tests/gateway/native-control-owned-bootstrap.mjs:1: .catch(() => ...) drops the error");
  });

  it("rejects the bare catch #3153 added to Electron Desktop code", () => {
    const result = scanChange({}, {
      "desktop/src/main/embeds/web-contents-view.ts": [
        "export function allowed(input: { url: string }) {",
        "  try {",
        "    return new URL(input.url).pathname === '/api/collaboration/direct-sessions';",
        "  } catch {",
        "    return false;",
        "  }",
        "}",
      ].join("\n"),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("desktop/src/main/embeds/web-contents-view.ts:4: catch without a binding drops the error");
  });

  it("rejects the unused `_err` binding #1187 used to get past the bare-catch rule", () => {
    const result = scanChange({}, {
      "desktop/src/main/external-url.ts": [
        "export function safeExternalHttpUrl(raw: string): string | null {",
        "  let parsed: URL;",
        "  try {",
        "    parsed = new URL(raw);",
        "  } catch (_err: unknown) {",
        "    return null;",
        "  }",
        "  return parsed.href;",
        "}",
      ].join("\n"),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("desktop/src/main/external-url.ts:5: catch binding is never read");
    expect(result.stdout).toContain("URL.canParse()");
  });

  it("does not fail a change for catches that already existed on unchanged lines", () => {
    const legacy = "try { run(); } catch { /* legacy */ }\nexport const a = 1;\n";
    const result = scanChange(
      { "scripts/legacy.mjs": legacy },
      { "scripts/legacy.mjs": `${legacy}export const b = 2;\n` },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Added lines — repo-wide rules");
    expect(result.stdout).not.toContain("[swallowed-error]");
  });

  it("accepts handled errors and ignores catch text inside strings, templates and comments", () => {
    const result = scanChange({}, {
      "scripts/handled.mjs": [
        "try { run(); } catch (error) {",
        "  if (!(error instanceof TypeError)) throw error;",
        "  console.warn('[handled] run failed', error.name);",
        "}",
        "promise.catch((err) => log(err));",
        "promise.catch(logFailure);",
        "try { run(); } catch ({ message }) { log(message); }",
        "const prompt = `Never write } catch { or .catch(() => {}) here: ${value}`;",
        "// } catch {",
        "const note = 'catch {';",
        "try { run(); } catch (error) { console.warn(`[handled] ${error instanceof Error ? error.name : 'unknown'}`); }",
      ].join("\n"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("[swallowed-error]");
  });

  it("honors a dated, approved exception and rejects an expired one", () => {
    const allowed = scanChange({}, {
      "scripts/probe.mjs": [
        "// pattern-allow swallowed-error: probe result is the absence of a module (expires 2999-01-01, approved-by hamedmp)",
        "try { require('optional-dep'); } catch { optional = false; }",
      ].join("\n"),
    });
    const expired = scanChange({}, {
      "scripts/probe.mjs": [
        "// pattern-allow swallowed-error: probe result is the absence of a module (expires 2020-01-01, approved-by hamedmp)",
        "try { require('optional-dep'); } catch { optional = false; }",
      ].join("\n"),
    });

    expect(allowed.status).toBe(0);
    expect(expired.status).toBe(1);
    expect(expired.stdout).toContain("exception expired on 2020-01-01");
  });

  it("checks uncommitted and untracked work in the default local mode", () => {
    const result = scanChange({}, { "scripts/draft.mjs": "load().catch(() => null);\n" }, { commit: false, args: [] });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("scripts/draft.mjs:1: .catch(() => ...) drops the error");
  });
});

function manyFiles(count: number, linesEach = 1) {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) files[`docs/part-${i}.md`] = "line\n".repeat(linesEach);
  return files;
}

describe("PR size rule", () => {
  it("rejects a PR with 53 files like #3062", () => {
    const result = scanChange({}, manyFiles(53), { args: ["--diff", "origin/main", "--pr"] });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("VIOLATION [pr-size] this change touches 53 files with 53 additions");
    expect(result.stdout).toContain("gh stack init / gh stack add");
  });

  it("rejects a fixture reformat that pushes a PR past 3000 additions like #3142", () => {
    const result = scanChange({}, { "tests/platform/fixtures/platform-schema-baseline.json": "{}\n".repeat(3001) }, {
      args: ["--diff", "origin/main", "--pr"],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("this change touches 1 files with 3001 additions");
  });

  it("accepts a PR at the limits and ignores the lockfile", () => {
    const result = scanChange({}, { ...manyFiles(50, 60), "pnpm-lock.yaml": "lock\n".repeat(9000) }, {
      args: ["--diff", "origin/main", "--pr"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("[pr-size]");
  });

  it("counts a rename once and its unchanged lines not at all", () => {
    const result = scanChange(manyFiles(1, 4000), {}, {
      args: ["--diff", "origin/main", "--pr"],
      rename: ["docs/part-0.md", "docs/moved.md"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("[pr-size]");
  });

  it("skips the size limit on CI push ranges, which can hold several merged PRs", () => {
    const result = scanChange({}, manyFiles(53));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("[pr-size]");
  });

  it("enforces the size limit in the default local mode", () => {
    const result = scanChange({}, manyFiles(51), { commit: false, args: [] });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("this change touches 51 files");
  });
});

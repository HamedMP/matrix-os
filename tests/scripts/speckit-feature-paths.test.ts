import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const source = resolve(".specify");

function repository(branch = "codex/preview-pair") {
  const root = mkdtempSync(join(tmpdir(), "matrix-specify-paths-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", "--initial-branch", branch, root], { timeout: 10_000 });
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "--allow-empty", "-m", "Fixture"], { timeout: 10_000 });
  mkdirSync(join(root, ".specify", "scripts", "bash"), { recursive: true });
  for (const name of ["common.sh", "setup-plan.sh", "check-prerequisites.sh"]) {
    cpSync(join(source, "scripts", "bash", name), join(root, ".specify", "scripts", "bash", name));
  }
  mkdirSync(join(root, ".specify", "templates"), { recursive: true });
  writeFileSync(join(root, ".specify", "templates", "plan-template.md"), "# Plan template\n");
  return root;
}

function feature(root: string, name = "2689-collaboration-preview-pair") {
  const relative = `specs/${name}`;
  mkdirSync(join(root, relative), { recursive: true });
  writeFileSync(join(root, relative, "spec.md"), "# Existing feature\n");
  return relative;
}

function pointer(root: string, directory: unknown) {
  writeFileSync(join(root, ".specify", "feature.json"), JSON.stringify({ feature_directory: directory }));
}

function run(root: string, script = "setup-plan.sh", extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!("SPECIFY_FEATURE" in extraEnv)) delete env.SPECIFY_FEATURE;
  if (!("SPECIFY_FEATURE_DIRECTORY" in extraEnv)) delete env.SPECIFY_FEATURE_DIRECTORY;
  return spawnSync("bash", [join(root, ".specify", "scripts", "bash", script), "--json",
    ...(script === "check-prerequisites.sh" ? ["--paths-only"] : [])],
  { cwd: root, env, encoding: "utf8", timeout: 10_000 });
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Spec Kit resolves the selected feature across independent stack branches", () => {
  it("uses the persisted feature pointer on a codex implementation branch", () => {
    const root = repository();
    const relative = feature(root);
    pointer(root, relative);
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(output.FEATURE_SPEC).toBe(join(root, relative, "spec.md"));
    expect(output.BRANCH).toBe("codex/preview-pair");
    expect(readFileSync(output.IMPL_PLAN, "utf8")).toBe("# Plan template\n");
  });

  it("accepts a four-digit branch when no feature pointer exists", () => {
    const root = repository("2689-collaboration-preview-pair");
    const relative = feature(root);
    const result = run(root, "check-prerequisites.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).FEATURE_DIR).toBe(join(root, relative));
  });

  it("preserves the existing three-digit prefix lookup", () => {
    const root = repository("123-next-layer");
    const relative = feature(root, "123-existing-feature");
    const result = run(root, "check-prerequisites.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).FEATURE_DIR).toBe(join(root, relative));
  });

  it("lets an explicit in-repository directory override the persisted selection", () => {
    const root = repository();
    pointer(root, feature(root));
    const selected = feature(root, "2690-explicit-selection");
    const result = run(root, "check-prerequisites.sh", { SPECIFY_FEATURE_DIRECTORY: selected });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).FEATURE_DIR).toBe(join(root, selected));
  });

  it("preserves the legacy explicit feature selector ahead of persisted metadata", () => {
    const root = repository();
    const persisted = feature(root);
    pointer(root, persisted);
    const selected = feature(root, "536-conversational-bots");
    writeFileSync(join(root, persisted, "plan.md"), "Keep original plan\n");
    const result = run(root, "setup-plan.sh", { SPECIFY_FEATURE: "536-conversational-bots" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!).FEATURE_SPEC).toBe(join(root, selected, "spec.md"));
    expect(readFileSync(join(root, persisted, "plan.md"), "utf8")).toBe("Keep original plan\n");
  });

  it("rejects a dangling metadata symlink instead of silently selecting a numeric branch", () => {
    const root = repository("123-existing-feature");
    feature(root, "123-existing-feature");
    symlinkSync(join(root, "missing-pointer.json"), join(root, ".specify", "feature.json"));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid feature directory");
  });

  it.each(["../outside-specs", "/tmp/outside-specs", "specs/../outside-specs", 42])(
    "rejects an invalid persisted directory instead of using a branch fallback: %s", (value) => {
      const root = repository("123-existing-feature");
      feature(root, "123-existing-feature");
      pointer(root, value);
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Invalid feature directory");
    });

  it("rejects a feature directory symlink that escapes specs", () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "matrix-specify-outside-"));
    roots.push(outside);
    mkdirSync(join(root, "specs"));
    symlinkSync(outside, join(root, "specs", "2689-escape"));
    pointer(root, "specs/2689-escape");
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid feature directory");
  });

  it("fails safely on malformed metadata", () => {
    const root = repository("123-existing-feature");
    feature(root, "123-existing-feature");
    writeFileSync(join(root, ".specify", "feature.json"), "{broken");
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid feature directory");
  });
});

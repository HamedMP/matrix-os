import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const targets = ["desktop/src/renderer/src/design/tokens.css", "home/system/theme.json", "shell/src/app/theme-defaults.css"];
const script = resolve("scripts/dev/sync-theme-defaults.ts");
const fixtures: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "theme-defaults-test-"));
  fixtures.push(root);
  for (const target of targets) {
    mkdirSync(dirname(join(root, target)), { recursive: true });
    writeFileSync(join(root, target), readFileSync(resolve(target)));
  }
  return root;
}
function run(root: string) {
  execFileSync("bun", [script], { cwd: root, stdio: "pipe", timeout: 30_000 });
}
function snapshot(root: string) { return targets.map(target => readFileSync(join(root, target), "utf8")); }
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("theme defaults synchronization", () => {
  it.each([
    [0, '[data-theme="dark"]', ""],
    [2, "/* Generated dark palette */", ""],
    [2, "/* Scope new control states", "/* Missing control states"],
    [2, "/* Generated dark palette */", "/* Generated dark palette */\n/* Generated dark palette */"],
  ])("leaves every target unchanged when a stylesheet marker is invalid (%s, %s)", (index, marker, replacement) => {
    const root = fixture();
    const target = join(root, targets[index as number]!);
    writeFileSync(target, readFileSync(target, "utf8").replace(marker as string, replacement as string));
    const before = snapshot(root);
    expect(() => run(root)).toThrow();
    expect(snapshot(root)).toEqual(before);
  });

  it("preserves control rules and produces byte-stable repeated output", () => {
    const root = fixture();
    const marker = "/* Scope new control states";
    const controls = snapshot(root)[2]!.slice(snapshot(root)[2]!.indexOf(marker));
    run(root);
    const first = snapshot(root);
    expect(first[2]!.slice(first[2]!.indexOf(marker))).toBe(controls);
    run(root);
    expect(snapshot(root)).toEqual(first);
  });
});

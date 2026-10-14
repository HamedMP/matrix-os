import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { discoverRecipeSkills } from "../../packages/gateway/src/chat/agent-recipe-skills.js";

const skillsRoot = resolve(__dirname, "../../skills/matrix");
const root = join(skillsRoot, "product-demo-video");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const lib = createRequire(import.meta.url)(join(root, "scripts/record-lib.cjs"));
const inside = (dir: string, path: string) => !relative(dir, path).startsWith("..");

describe("Matrix product demo video skill", () => {
  it("is discovered by the bundled recipe loader", async () => {
    const discovered = await discoverRecipeSkills({ skillsRoot }, false);
    expect(discovered.map((skill) => skill.id)).toContain("matrix-product-demo-video");
  });

  it("uses the shared skill frontmatter shape", () => {
    const content = read("SKILL.md");
    expect(content.split("\n")[1]).toMatch(/^triggers:\s*\[[^\]]+\]$/);
    expect(content).toMatch(/^name: matrix-product-demo-video$/m);
    expect(content).toMatch(/^version: 1\.0\.0$/m);
    expect(content).toMatch(/^author: Matrix OS$/m);
    expect(content).toMatch(/^related_skills: \[.+\]$/m);
    expect(content).toMatch(/^# Matrix Product Demo Video$/m);
    expect(content).toMatch(/^## When to Use$/m);
  });

  it("stays generic instead of describing one feature's recording", () => {
    for (const file of ["SKILL.md", "scripts.md", "example-recorder.cjs"]) {
      const content = read(file);
      expect(content, file).not.toMatch(/#\d{3,}|onboarding|\/Users\//i);
    }
  });

  it("is listed in the shipped skill docs", () => {
    const docs = readFileSync(resolve(__dirname, "../../docs/dev/agent-matrix-skills.md"), "utf8");
    expect(docs).toContain("| `matrix-product-demo-video` |");
  });

  it("keeps compiled encoder tools out of the skill directory", () => {
    expect(inside(root, lib.ENCODER_BIN)).toBe(false);
    expect(inside(root, lib.STITCH_BIN)).toBe(false);
    expect(inside(tmpdir(), lib.ENCODER_BIN)).toBe(true);
  });

  it("gives each session its own temp frames folder", () => {
    const first = lib.makeSession(lib.WEB);
    const second = lib.makeSession(lib.WEB);
    try {
      for (const session of [first, second]) {
        expect(existsSync(session.timeline.framesDir)).toBe(true);
        expect(inside(tmpdir(), session.timeline.framesDir)).toBe(true);
        expect(session.timeline.framesDir).toMatch(/mxo-demo-frames-/);
        expect(readdirSync(session.timeline.framesDir)).toEqual([]);
      }
      expect(first.timeline.framesDir).not.toBe(second.timeline.framesDir);
    } finally {
      for (const session of [first, second]) rmSync(session.timeline.framesDir, { recursive: true, force: true });
    }
  });

  it("refuses to write encoded or stitched videos inside the skill", () => {
    expect(() => lib.encodeTimeline({
      frames: [], segments: [], cameras: [], captions: [],
    }, lib.WEB, join(root, "oops.mp4"))).toThrow(/must not be written inside the skill/);
    expect(() => lib.stitch({ output: join(root, "oops.mp4"), chapters: [] }))
      .toThrow(/must not be written inside the skill/);
  });

  it("ignores compiled encoder binaries next to the Swift sources", () => {
    const ignore = read("scripts/.gitignore");
    expect(ignore).toMatch(/^encode-demo$/m);
    expect(ignore).toMatch(/^stitch-complete$/m);
  });
});

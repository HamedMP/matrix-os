import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const repo = resolve(__dirname, "../..");
const root = join(repo, ".agents/skills/product-demo-video");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const readRepo = (file: string) => readFileSync(join(repo, file), "utf8");
const lib = createRequire(import.meta.url)(join(root, "scripts/record-lib.cjs"));
const inside = (dir: string, path: string) => !relative(dir, path).startsWith("..");

describe("Matrix product demo video skill", () => {
  it("is a team skill, not part of the skill pack shipped to customer computers", () => {
    expect(existsSync(join(repo, "skills/matrix/product-demo-video"))).toBe(false);
    for (const file of [
      "scripts/install-agent-matrix-skills.sh",
      "scripts/install-hermes-matrix-skills.sh",
      "docs/dev/agent-matrix-skills.md",
    ]) {
      expect(readRepo(file), file).not.toMatch(/product-demo-video/);
    }
  });

  it("is tracked for agents working in this repo", () => {
    const ignore = readRepo(".gitignore");
    expect(ignore).toMatch(/^!\.agents\/skills\/product-demo-video\/\*\*$/m);
    expect(ignore).toMatch(/^!\.claude\/skills\/product-demo-video$/m);
    expect(read("../../../.claude/skills/product-demo-video/SKILL.md")).toBe(read("SKILL.md"));
  });

  it("uses the team skill frontmatter shape", () => {
    const content = read("SKILL.md");
    expect(content.split("\n")[1]).toBe("name: product-demo-video");
    expect(content.split("\n")[2]).toMatch(/^description: .*team.*$/i);
    expect(content).toMatch(/^# Matrix Product Demo Video$/m);
    expect(content).toMatch(/^## When to Use$/m);
  });

  it("stays generic instead of describing one feature's recording", () => {
    for (const file of ["SKILL.md", "scripts.md", "example-recorder.cjs"]) {
      const content = read(file);
      expect(content, file).not.toMatch(/#\d{3,}|onboarding|\/Users\//i);
    }
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

  it("waits for pending frame writes before stopCapture returns", async () => {
    let finished = false;
    const session = {
      writes: [new Promise((resolveWrite) => {
        setTimeout(() => {
          finished = true;
          resolveWrite(undefined);
        }, 40);
      })],
      cdp: { send: async () => undefined },
      timeline: { segments: [{ start: 0, end: null }] },
    };
    await lib.stopCapture(session);
    expect(finished).toBe(true);
    expect(session.writes).toEqual([]);
    expect(session.timeline.segments.at(-1).end).toBeGreaterThan(0);
  });

  it("waits for snapshotFrame to finish writing", async () => {
    const session = lib.makeSession(lib.WEB);
    let wrote = false;
    session.cdp = {
      send: async () => {
        wrote = true;
        return { data: Buffer.from("jpeg").toString("base64") };
      },
    };
    try {
      await lib.snapshotFrame(session);
      expect(wrote).toBe(true);
      expect(session.writes).toHaveLength(1);
      await session.writes[0];
      expect(existsSync(session.timeline.frames[0].file)).toBe(true);
    } finally {
      rmSync(session.timeline.framesDir, { recursive: true, force: true });
    }
  });

  it("refuses an empty Electron profile before launching", async () => {
    const electron = { launch: async () => {
      throw new Error("must not launch");
    } };
    await expect(lib.launchElectron(electron, { repo: "/tmp/unused", profile: "" }))
      .rejects.toThrow(/isolated profile/i);
    await expect(lib.launchElectron(electron, { repo: "/tmp/unused", profile: "   " }))
      .rejects.toThrow(/isolated profile/i);
  });

  it("gives up when the screencast never sends a frame", async () => {
    const session = lib.makeSession(lib.WEB);
    const sent = [];
    session.cdp = {
      send: async (method) => {
        sent.push(method);
      },
      on() {},
    };
    await expect(lib.startCapture(session, {
      waitForTimeout: (ms) => new Promise((resolveWait) => setTimeout(resolveWait, Math.min(ms, 5))),
    }, { timeoutMs: 30 })).rejects.toThrow(/no frames/i);
    expect(sent).toContain("Page.startScreencast");
    expect(sent).toContain("Page.stopScreencast");
    rmSync(session.timeline.framesDir, { recursive: true, force: true });
  });

  it("clamps fades so a short clip cannot go negative", () => {
    expect(lib.fadeOverlapSeconds(0.45, 0.6, 1.6)).toBeCloseTo(0.3);
    expect(lib.fadeOverlapSeconds(0.45, 1.6, 0.6)).toBeCloseTo(0.3);
    expect(lib.fadeOverlapSeconds(0.45, 2, 2)).toBeCloseTo(0.45);
    expect(lib.fadeOverlapSeconds(0.45, 2, 0)).toBe(0);
  });

  it("documents the QA sheet folder and a 1.6s card default", () => {
    expect(read("SKILL.md")).toMatch(/mkdir -p "\$TMPDIR\/mxo-demo-tools" "\$TMPDIR\/mxo-demo-qa"/);
    expect(read("scripts/stitch-complete.swift")).toMatch(/cardSeconds \?\? 1\.6/);
    expect(read("scripts/stitch-complete.swift")).toMatch(/fadeOverlap\(/);
  });
});

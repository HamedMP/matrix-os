import { afterEach, describe, expect, it } from "vitest";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getNativeFileCapability,
  isNativeFileCapabilityTarget,
} from "../../packages/gateway/src/file-management/native-file-capability.js";

const describeNative = isNativeFileCapabilityTarget() ? describe : describe.skip;

describeNative("Gateway native recursive copy bounds", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeHome(label: string): string {
    const home = join(tmpdir(), `matrix-native-bound-${label}-${process.pid}-${Date.now()}`);
    mkdirSync(join(home, "source"), { recursive: true });
    roots.push(home);
    return home;
  }

  function createEmptyFiles(directory: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
      closeSync(openSync(join(directory, `entry-${index}`), "wx"));
    }
  }

  it("accepts exactly 10,000 entries and fails closed at 10,001", async () => {
    const atLimit = makeHome("entries-ok");
    createEmptyFiles(join(atLimit, "source"), 9_999);
    expect(await getNativeFileCapability().copy(atLimit, "source", "target", false))
      .toEqual({ ok: true, code: "ok" });

    const overLimit = makeHome("entries-fail");
    createEmptyFiles(join(overLimit, "source"), 10_000);
    expect(await getNativeFileCapability().copy(overLimit, "source", "target", false))
      .toMatchObject({ ok: false, code: "partial", partialPath: expect.stringMatching(/^\.matrix-copy-stage-/) });
  }, 60_000);

  it("accepts depth 128 and fails closed at depth 129", async () => {
    const atLimit = makeHome("depth-ok");
    let directory = join(atLimit, "source");
    for (let depth = 0; depth < 128; depth += 1) {
      directory = join(directory, "d");
      mkdirSync(directory);
    }
    expect(await getNativeFileCapability().copy(atLimit, "source", "target", false))
      .toEqual({ ok: true, code: "ok" });

    const overLimit = makeHome("depth-fail");
    directory = join(overLimit, "source");
    for (let depth = 0; depth < 129; depth += 1) {
      directory = join(directory, "d");
      mkdirSync(directory);
    }
    expect(await getNativeFileCapability().copy(overLimit, "source", "target", false))
      .toMatchObject({ ok: false, code: "partial", partialPath: expect.stringMatching(/^\.matrix-copy-stage-/) });
  }, 30_000);

  it("removes expired internal copy stages before claiming another directory stage", async () => {
    const home = makeHome("expired-stages");
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    for (let index = 0; index < 3; index += 1) {
      const stage = join(home, `.matrix-copy-stage-${index.toString(16).padStart(32, "0")}`);
      mkdirSync(stage);
      writeFileSync(join(stage, "partial.txt"), "partial");
      utimesSync(stage, expired, expired);
    }

    expect(await getNativeFileCapability().copy(home, "source", "target", false))
      .toEqual({ ok: true, code: "ok" });
    expect(readdirSync(home).filter((name) => name.startsWith(".matrix-copy-stage-"))).toEqual([]);
  });

  it("caps recent retained stages and never follows a stage-named symlink", async () => {
    const home = makeHome("stage-cap");
    const outside = makeHome("stage-outside");
    writeFileSync(join(outside, "owner.txt"), "owner");
    const symlinkName = ".matrix-copy-stage-ffffffffffffffffffffffffffffffff";
    symlinkSync(outside, join(home, symlinkName), "dir");
    for (let index = 0; index < 64; index += 1) {
      mkdirSync(join(home, `.matrix-copy-stage-${index.toString(16).padStart(32, "0")}`));
    }

    expect(await getNativeFileCapability().copy(home, "source", "target", false))
      .toEqual({ ok: false, code: "limit_exceeded" });
    const retainedDirectories = readdirSync(home)
      .filter((name) => name.startsWith(".matrix-copy-stage-") && name !== symlinkName);
    expect(retainedDirectories).toHaveLength(64);
    expect(existsSync(join(home, "target"))).toBe(false);
    expect(existsSync(join(home, symlinkName))).toBe(true);
    expect(existsSync(join(outside, "owner.txt"))).toBe(true);
  });
});

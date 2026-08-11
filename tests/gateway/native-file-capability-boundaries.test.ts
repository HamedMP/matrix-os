import { afterEach, describe, expect, it } from "vitest";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
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
});

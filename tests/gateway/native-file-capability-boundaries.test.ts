import { afterEach, describe, expect, it } from "vitest";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getNativeFileCapability,
  getNativeFileCapabilityTestHarness,
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

  it("retains a changed expired stage instead of cleaning a substituted child", async () => {
    const home = makeHome("stage-child-swap");
    const stageName = ".matrix-copy-stage-00000000000000000000000000000000";
    const stage = join(home, stageName);
    mkdirSync(join(stage, "child"), { recursive: true });
    writeFileSync(join(stage, "child", "owner.txt"), "owner");
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(stage, expired, expired);

    expect(await getNativeFileCapabilityTestHarness().copyWithScenario(
      home,
      "source",
      "target",
      false,
      "replace_retained_child_before_open",
    )).toEqual({ ok: true, code: "ok" });

    expect(readFileSync(join(stage, ".matrix-sweep-original", "owner.txt"), "utf8")).toBe("owner");
    expect(readFileSync(join(stage, "child", "claimant.txt"), "utf8")).toBe("claimant");
  });

  it.each(["file", "symlink"] as const)(
    "retains a changed expired stage instead of deleting a substituted %s leaf",
    async (kind) => {
      const home = makeHome(`stage-${kind}-swap`);
      const stageName = ".matrix-copy-stage-00000000000000000000000000000000";
      const stage = join(home, stageName);
      mkdirSync(stage);
      if (kind === "file") {
        writeFileSync(join(stage, "leaf"), "owner");
      } else {
        symlinkSync("owner-target", join(stage, "leaf"));
      }
      const expired = new Date(Date.now() - 25 * 60 * 60 * 1_000);
      utimesSync(stage, expired, expired);

      expect(await getNativeFileCapabilityTestHarness().copyWithScenario(
        home,
        "source",
        "target",
        false,
        "replace_retained_leaf_before_quarantine",
      )).toEqual({ ok: true, code: "ok" });

      const quarantined = readdirSync(stage)
        .find((name) => name.startsWith(".matrix-sweep-quarantine-"));
      expect(quarantined).toBeDefined();
      if (kind === "file") {
        expect(readFileSync(join(stage, ".matrix-sweep-original-leaf"), "utf8")).toBe("owner");
        expect(readFileSync(join(stage, quarantined!), "utf8")).toBe("claimant");
      } else {
        expect(readlinkSync(join(stage, ".matrix-sweep-original-leaf"))).toBe("owner-target");
        expect(readlinkSync(join(stage, quarantined!))).toBe("claimant-target");
      }
    },
  );

  it.each([
    ["same-size rewrite", "rewrite_retained_leaf_before_quarantine"],
    ["chmod-only mutation", "chmod_retained_leaf_before_quarantine"],
  ] as const)("retains an expired stage after a regular leaf %s", async (_label, scenario) => {
    const home = makeHome("stage-leaf-mutation");
    const stageName = ".matrix-copy-stage-00000000000000000000000000000000";
    const stage = join(home, stageName);
    mkdirSync(stage);
    writeFileSync(join(stage, "leaf"), "owner");
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(stage, expired, expired);

    expect(await getNativeFileCapabilityTestHarness().copyWithScenario(
      home,
      "source",
      "target",
      false,
      scenario,
    )).toEqual({ ok: true, code: "ok" });

    const quarantined = readdirSync(stage)
      .find((name) => name.startsWith(".matrix-sweep-quarantine-"));
    expect(quarantined).toBeDefined();
    if (scenario === "rewrite_retained_leaf_before_quarantine") {
      expect(readFileSync(join(stage, quarantined!), "utf8")).toBe("rival");
    } else {
      expect(readFileSync(join(stage, quarantined!), "utf8")).toBe("owner");
      expect(statSync(join(stage, quarantined!)).mode & 0o100).toBe(0o100);
    }
  });

  it("keeps an old active stage locked and enforces the cap for another copy", async () => {
    const home = makeHome("active-stage-cap");
    for (let index = 0; index < 63; index += 1) {
      mkdirSync(join(home, `.matrix-copy-stage-${index.toString(16).padStart(32, "0")}`));
    }
    const paused = getNativeFileCapabilityTestHarness().copyWithScenario(
      home,
      "source",
      "first-target",
      false,
      "pause_after_stage_claim",
    );
    const ready = join(home, ".matrix-copy-test-ready");
    await expect.poll(() => existsSync(ready), { timeout: 5_000 }).toBe(true);
    const activeStage = readFileSync(ready, "utf8");
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(join(home, activeStage), expired, expired);

    await expect(getNativeFileCapability().copy(home, "source", "second-target", false))
      .resolves.toEqual({ ok: false, code: "limit_exceeded" });
    expect(existsSync(join(home, activeStage))).toBe(true);

    writeFileSync(join(home, ".matrix-copy-test-release"), "release");
    await expect(paused).resolves.toEqual({ ok: true, code: "ok" });
  }, 10_000);

  it("serializes the 63-to-64 sweep and claim boundary without blocking", async () => {
    const home = makeHome("parallel-stage-claim");
    for (let index = 0; index < 63; index += 1) {
      mkdirSync(join(home, `.matrix-copy-stage-${index.toString(16).padStart(32, "0")}`));
    }
    const paused = getNativeFileCapabilityTestHarness().copyWithScenario(
      home,
      "source",
      "first-target",
      false,
      "pause_after_stage_sweep",
    );
    await expect.poll(
      () => existsSync(join(home, ".matrix-copy-test-sweep-ready")),
      { timeout: 5_000 },
    ).toBe(true);

    await expect(getNativeFileCapability().copy(home, "source", "second-target", false))
      .resolves.toEqual({ ok: false, code: "failed" });
    expect(readdirSync(home).filter((name) => name.startsWith(".matrix-copy-stage-")))
      .toHaveLength(63);

    writeFileSync(join(home, ".matrix-copy-test-release"), "release");
    await expect(paused).resolves.toEqual({ ok: true, code: "ok" });
    expect(readdirSync(home).filter((name) => name.startsWith(".matrix-copy-stage-")))
      .toHaveLength(63);
  }, 10_000);

  it("fails closed when the target parent scan exceeds its fixed budget", async () => {
    const home = makeHome("stage-scan-budget");
    for (let index = 0; index <= 10_000; index += 1) {
      writeFileSync(join(home, `unrelated-${index}`), "x");
    }

    await expect(getNativeFileCapability().copy(home, "source", "target", false))
      .resolves.toEqual({ ok: false, code: "limit_exceeded" });
    expect(existsSync(join(home, "target"))).toBe(false);
  }, 30_000);
});

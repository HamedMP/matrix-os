import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getNativeFileCapability,
  isNativeFileCapabilityTarget,
  NativeFileCapabilityUnavailableError,
} from "../../packages/gateway/src/file-management/native-file-capability.js";
import { fileMkdir } from "../../packages/gateway/src/file-ops.js";

const isRequiredLinuxTarget = process.platform === "linux"
  && process.arch === "x64"
  && Boolean(process.report.getReport().header.glibcVersionRuntime);

describe("Gateway native file capability loader", () => {
  it("fails closed away from the supported Linux x64 glibc target", () => {
    expect(isNativeFileCapabilityTarget()).toBe(isRequiredLinuxTarget);
    if (!isRequiredLinuxTarget) {
      expect(() => getNativeFileCapability()).toThrow(NativeFileCapabilityUnavailableError);
    }
  });

  it.runIf(!isRequiredLinuxTarget)("does not fall back to pathname-based structural mutation", async () => {
    const home = join(tmpdir(), `matrix-native-fail-closed-${process.pid}-${Date.now()}`);
    mkdirSync(home);
    try {
      expect(await fileMkdir(home, "must-not-exist")).toEqual({
        ok: false,
        error: "Failed to create directory",
      });
      expect(existsSync(join(home, "must-not-exist"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.runIf(isRequiredLinuxTarget)("Gateway native file capability on Linux x64 glibc", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeRoot(name: string): string {
    const root = join(tmpdir(), `matrix-native-fs-${name}-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
    return root;
  }

  it("preserves an occupied move target and the source claimant", async () => {
    const home = makeRoot("claimant");
    writeFileSync(join(home, "source.txt"), "source");
    writeFileSync(join(home, "target.txt"), "claimant");
    const capability = getNativeFileCapability();

    const result = await capability.move(home, "source.txt", "target.txt", false);

    expect(result).toMatchObject({ ok: false, code: "destination_conflict" });
    expect(readFileSync(join(home, "source.txt"), "utf8")).toBe("source");
    expect(readFileSync(join(home, "target.txt"), "utf8")).toBe("claimant");
  });

  it("contains a target-parent symlink swap inside the owner home boundary", async () => {
    const home = makeRoot("home");
    const outside = makeRoot("outside");
    mkdirSync(join(home, "target-parent"));
    writeFileSync(join(home, "source.txt"), "source");
    rmSync(join(home, "target-parent"), { recursive: true });
    symlinkSync(outside, join(home, "target-parent"), "dir");
    const capability = getNativeFileCapability();

    const result = await capability.copy(home, "source.txt", "target-parent/copied.txt", false);

    expect(result).toMatchObject({ ok: false, code: "invalid_path" });
    expect(existsSync(join(outside, "copied.txt"))).toBe(false);
  });

  it("retains exactly one claimed partial target after a nested copy failure", async () => {
    const home = makeRoot("partial");
    mkdirSync(join(home, "source"));
    const fifo = join(home, "source", "unsupported-fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const capability = getNativeFileCapability();

    const result = await capability.copy(home, "source", "target", false);

    expect(result).toMatchObject({ ok: false, code: "partial" });
    expect(result.partialPath).toMatch(/^\.matrix-copy-stage-[a-f0-9]{32}$/);
    expect(statSync(join(home, result.partialPath!)).isDirectory()).toBe(true);
    expect(existsSync(join(home, "target"))).toBe(false);
    expect(existsSync(join(home, "target copy"))).toBe(false);
  });

  it("reports the claimed destination when a regular-file copy fails after creation", async () => {
    const home = makeRoot("partial-file");
    writeFileSync(join(home, "source.txt"), "source");

    const result = await getNativeFileCapabilityTestHarness().copyWithScenario(
      home,
      "source.txt",
      "target.txt",
      false,
      "fail_regular_after_target_claim",
    );

    expect(result).toEqual({ ok: false, code: "partial", partialPath: "target.txt" });
    expect(existsSync(join(home, "target.txt"))).toBe(true);
  });

  it("copies nested symlinks without dereferencing and preserves executable mode", async () => {
    const home = makeRoot("metadata");
    mkdirSync(join(home, "source"));
    writeFileSync(join(home, "source", "run.sh"), "#!/bin/sh\n");
    chmodSync(join(home, "source", "run.sh"), 0o751);
    symlinkSync("run.sh", join(home, "source", "run-link"));
    const capability = getNativeFileCapability();

    expect(await capability.copy(home, "source", "target", false)).toEqual({ ok: true, code: "ok" });

    expect(statSync(join(home, "target", "run.sh")).mode & 0o777).toBe(0o751);
    expect(lstatSync(join(home, "target", "run-link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, "target", "run-link"))).toBe("run.sh");
    expect(readFileSync(join(home, "target", "run-link"), "utf8")).toBe("#!/bin/sh\n");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getNativeFileCapability,
  getNativeFileCapabilityTestHarness,
  isNativeFileCapabilityTarget,
  NativeFileCapabilityUnavailableError,
  type NativeFileCapabilityResult,
} from "../../packages/gateway/src/file-management/native-file-capability.js";

const describeNative = isNativeFileCapabilityTarget() ? describe : describe.skip;

it.runIf(!isNativeFileCapabilityTarget())("keeps the native race harness fail-closed off Linux", () => {
  expect(() => getNativeFileCapabilityTestHarness()).toThrow(NativeFileCapabilityUnavailableError);
});

describeNative("Gateway native copy race boundaries", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeHome(label: string): string {
    const home = join(tmpdir(), `matrix-native-race-${label}-${randomUUID()}`);
    mkdirSync(join(home, "source"), { recursive: true });
    roots.push(home);
    return home;
  }

  function requirePartialPath(result: NativeFileCapabilityResult): string {
    expect(result.partialPath).toMatch(/^\.matrix-copy-stage-[a-f0-9]{32}$/);
    return result.partialPath!;
  }

  it("never writes children into a final-directory claimant installed after staging", async () => {
    const home = makeHome("final-claimant");
    writeFileSync(join(home, "source", "child.txt"), "source-child");

    const result = await getNativeFileCapabilityTestHarness().copyWithScenario(
      home,
      "source",
      "target",
      false,
      "replace_final_after_stage_claim",
    );

    expect(result).toMatchObject({ ok: false, code: "destination_conflict" });
    const partialPath = requirePartialPath(result);
    expect(readFileSync(join(home, "target", "claimant.txt"), "utf8")).toBe("claimant");
    expect(existsSync(join(home, "target", "child.txt"))).toBe(false);
    expect(readFileSync(join(home, partialPath, "child.txt"), "utf8")).toBe("source-child");
  });

  it("rejects a source mode change between identity and readable open", async () => {
    const home = makeHome("mode-change");
    const source = join(home, "source", "mode.txt");
    writeFileSync(source, "stable-bytes");
    chmodSync(source, 0o751);

    const result = await getNativeFileCapabilityTestHarness().copyWithScenario(
      home,
      "source",
      "target",
      false,
      "chmod_source_after_identity",
    );

    expect(result).toMatchObject({ ok: false, code: "partial" });
    const partialPath = requirePartialPath(result);
    expect(statSync(source).mode & 0o777).toBe(0o651);
    expect(existsSync(join(home, "target"))).toBe(false);
    expect(existsSync(join(home, partialPath, "mode.txt"))).toBe(false);
  });

  it("rejects a discovered child replaced by an external symlink before data open", async () => {
    const home = makeHome("source-swap");
    const source = join(home, "source", "swap.txt");
    writeFileSync(source, "owner-bytes");

    const result = await getNativeFileCapabilityTestHarness().copyWithScenario(
      home,
      "source",
      "target",
      false,
      "replace_source_after_identity",
    );

    expect(result).toMatchObject({ ok: false, code: "partial" });
    const partialPath = requirePartialPath(result);
    expect(lstatSync(source).isSymbolicLink()).toBe(true);
    expect(readlinkSync(source)).toBe("/etc/passwd");
    expect(existsSync(join(home, "target"))).toBe(false);
    expect(existsSync(join(home, partialPath, "swap.txt"))).toBe(false);
  });

  it("rejects traversing from the owner descriptor into another mount", async () => {
    const targetName = `matrix-native-xdev-${randomUUID()}`;
    const targetPath = `tmp/${targetName}`;
    const targetAbsolute = join(tmpdir(), targetName);
    roots.push(targetAbsolute);

    const result = await getNativeFileCapability().copy("/", "proc/version", targetPath, false);

    expect(result).toEqual({ ok: false, code: "cross_device" });
    expect(existsSync(targetAbsolute)).toBe(false);
  });
});

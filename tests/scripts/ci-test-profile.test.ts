import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalizeTestPath, profileReports, validateDurations, writeProfile } from "../../scripts/ci/test-profile.mjs";
const root = "/repo";
const report = (name: string, duration: number) => ({ testResults: [{ name, startTime: 100, endTime: 100 + duration }] });

describe("safe Vitest profile", () => {
  it("normalizes in-root absolute names and canonical relative test names", () => {
    expect(normalizeTestPath("/repo/tests/a.test.ts", root)).toBe("tests/a.test.ts");
    expect(normalizeTestPath("tests/a.test.tsx", root)).toBe("tests/a.test.tsx");
  });
  it.each(["/private/secret.test.ts", "../tests/a.test.ts", "tests/../secret.test.ts", "tests/a\n.test.ts", "tests/a.ts", "C:\\secrets\\a.test.ts", "tests//a.test.ts"])("rejects unsafe/non-test name %j", (name) => {
    expect(() => normalizeTestPath(name, root)).toThrow(/test path/);
  });
  it("takes median repeated measurements and produces deterministic public-safe durations", () => {
    const result = profileReports([report("/repo/tests/b.test.ts", 40), report("tests/a.test.ts", 100), report("tests/a.test.ts", 300)], root);
    expect(result.manifest).toEqual({ version: 1, durationsMs: { "tests/a.test.ts": 200, "tests/b.test.ts": 40 } });
    expect(result.summary).toMatchObject({ files: 2, samples: 3, totalMs: 240, medianMs: 120 });
    expect(JSON.stringify(result)).not.toContain("/repo");
  });
  it("skips unexecuted suites without introducing zero-cost failures", () => {
    expect(profileReports([{ testResults: [{ name: "tests/a.test.ts", status: "pending" }] }], root).manifest.durationsMs).toEqual({});
  });
  it.each([NaN, Infinity, -1, 3_600_001])("rejects invalid durations %s", (duration) => {
    expect(() => profileReports([report("tests/a.test.ts", duration)], root)).toThrow(/duration/);
  });
  it("validates manifests before sequencing", () => {
    expect(validateDurations({ version: 1, durationsMs: { "tests/a.test.ts": 0 } })).toEqual({ "tests/a.test.ts": 1 });
    expect(() => validateDurations({ version: 2, durationsMs: {} })).toThrow();
    expect(() => validateDurations({ version: 1, durationsMs: { "../secret": 1 } })).toThrow();
    expect(() => validateDurations({ version: 1, durationsMs: { [path.resolve("tests/a.test.ts")]: 1 } })).toThrow();
  });
  it("atomically replaces a profile and removes temporary files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ci-profile-"));
    try {
      const output = path.join(dir, "durations.json");
      await writeFile(output, "old");
      await writeProfile(output, { version: 1, durationsMs: { "tests/a.test.ts": 10 } });
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ version: 1, durationsMs: { "tests/a.test.ts": 10 } });
      expect(await readdir(dir)).toEqual(["durations.json"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("CLI consumes reports, emits summary, and reports bounded errors without private paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ci-profile-"));
    try {
      const input = path.join(dir, "report.json");
      const output = path.join(dir, "durations.json");
      await writeFile(input, JSON.stringify(report("/repo/tests/a.test.ts", 50)));
      const script = path.resolve("scripts/ci/test-profile.mjs");
      const ok = spawnSync(process.execPath, [script, "--root", root, "--output", output, input], { encoding: "utf8" });
      expect(ok.status).toBe(0);
      expect(JSON.parse(ok.stdout)).toMatchObject({ files: 1, totalMs: 50 });
      const bad = spawnSync(process.execPath, [script, path.join(dir, "private-does-not-exist")], { encoding: "utf8" });
      expect(bad.status).toBe(1);
      expect(bad.stderr.length).toBeLessThan(300);
      expect(bad.stderr).not.toContain(dir);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

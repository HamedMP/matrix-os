import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeParityState } from "../../scripts/local-production-parity/state.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "parity-state-")); roots.push(root);
  const path = join(root, "state.json");
  const original = '{"machineId":"retained","platformSecret":"fixture-secret"}\n';
  writeFileSync(path, original, { mode: 0o600 });
  return { root, path, original };
}

it("preserves the complete retained identity when committing a new state fails", () => {
  const { root, path, original } = fixture();
  expect(() => writeParityState(path, { machineId: "new" }, { rename: () => { throw new Error("fixture storage failure"); } })).toThrow("fixture storage failure");
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(readdirSync(root)).toEqual(["state.json"]);
});

it("recovers one abandoned temporary file and keeps state private", () => {
  const { root, path } = fixture();
  writeFileSync(`${path}.next`, "interrupted write", { mode: 0o600 });
  writeParityState(path, { machineId: "retained", seededMachineId: "retained" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ machineId: "retained", seededMachineId: "retained" });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(root)).toEqual(["state.json"]);
});

it("refuses a symlink at the temporary path without changing its target or retained state", () => {
  const { root, path, original } = fixture();
  const outside = join(root, "unrelated"); writeFileSync(outside, "keep");
  symlinkSync(outside, `${path}.next`);
  expect(() => writeParityState(path, { machineId: "new" })).toThrow(/temporary/);
  expect(readFileSync(outside, "utf8")).toBe("keep");
  expect(readFileSync(path, "utf8")).toBe(original);
});

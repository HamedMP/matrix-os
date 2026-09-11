import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const script = resolve("skills/matrix/app-builder/scripts/verify-app.mjs");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(overrides: Record<string, unknown> = {}, built = true) {
  const dir = mkdtempSync(join(tmpdir(), "matrix-builder-"));
  dirs.push(dir);
  writeFileSync(join(dir, "matrix.json"), JSON.stringify({
    name: "Spec Reader", slug: "spec-reader", version: "1.0.0", runtime: "vite",
    runtimeVersion: "^1.0.0", listingTrust: "first_party", scope: "personal",
    build: { command: "pnpm build", output: "dist" }, ...overrides,
  }));
  if (built) { mkdirSync(join(dir, "dist")); writeFileSync(join(dir, "dist/index.html"), "<!doctype html>"); }
  return dir;
}

it("verifies a built owner app and prints the real Matrix launch path", () => {
  expect(execFileSync(process.execPath, [script, fixture()], { encoding: "utf8" })).toContain("/apps/spec-reader/");
});

it.each([
  { listingTrust: undefined }, { listingTrust: "community" }, { scope: "shared" },
  { slug: "../escape" }, { runtime: "node" }, { runtimeVersion: undefined },
  { build: { command: "pnpm build", output: "../dist" } },
])("rejects an app that cannot use the owner-built Vite launch contract: %j", (overrides) => {
  expect(() => execFileSync(process.execPath, [script, fixture(overrides)], { stdio: "pipe" })).toThrow();
});

it("rejects a valid manifest without its production build", () => {
  expect(() => execFileSync(process.execPath, [script, fixture({}, false)], { stdio: "pipe" })).toThrow();
});

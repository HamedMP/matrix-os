import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_PORT_RANGE } from "../../../packages/gateway/src/app-runtime/port-pool.js";
import { TEST_PORT_RANGES } from "./test-ports.js";

const LINUX_EPHEMERAL_MIN = 32768;

// Test files that spawn real app servers from a PortPool.
const SPAWNING_TEST_FILES = [
  "tests/gateway/app-runtime/process-manager.test.ts",
  "tests/gateway/app-runtime/dispatcher.test.ts",
  "tests/gateway/app-runtime-phase2.test.ts",
];

describe("app-runtime test port ranges", () => {
  const ranges = Object.entries(TEST_PORT_RANGES);

  it("stay below the Linux ephemeral range and outside the production app range", () => {
    for (const [name, range] of ranges) {
      expect(range.min, name).toBeLessThanOrEqual(range.max);
      expect(range.max, name).toBeLessThan(LINUX_EPHEMERAL_MIN);
      const overlapsApp = range.min <= APP_PORT_RANGE.max && range.max >= APP_PORT_RANGE.min;
      expect(overlapsApp, name).toBe(false);
    }
  });

  it("never overlap each other", () => {
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const [nameA, a] = ranges[i];
        const [nameB, b] = ranges[j];
        const overlaps = a.min <= b.max && a.max >= b.min;
        expect(overlaps, `${nameA} overlaps ${nameB}`).toBe(false);
      }
    }
  });

  it("are the only port pools spawning tests construct", async () => {
    for (const file of SPAWNING_TEST_FILES) {
      const source = await readFile(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/new PortPool(?:Ctor)?\(\s*\{\s*min:\s*\d/);
    }
  });
});

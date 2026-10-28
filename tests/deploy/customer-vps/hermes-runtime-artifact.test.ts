import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const run = promisify(execFile);
it("publishes and recovers real isolated source artifacts without changing owner state", async () => {
  const result = await run("python3", ["-I", "-B", "tests/deploy/customer-vps/hermes-runtime-artifact-cases.py", "scripts/publish-hermes-runtime.py"], { timeout: 30_000, maxBuffer: 128 * 1024 });
  const line = result.stdout.split("\n").find(line => line.startsWith("ARTIFACT_TEST_RESULT:"));
  expect(line).toBeDefined();
  const facts = JSON.parse(line!.slice("ARTIFACT_TEST_RESULT:".length));
  expect(facts.testsRun).toBeGreaterThanOrEqual(11);
  expect(facts.failures).toBe(0); expect(facts.errors).toBe(0);
}, 35_000);

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("isolates dry-run release queues by ref/channel while retaining publish and tag serialization", async () => {
  const release = parse(await readFile(join(process.cwd(), ".github/workflows/desktop-release.yml"), "utf8"));
  const canary = parse(await readFile(join(process.cwd(), ".github/workflows/desktop-release-canary.yml"), "utf8"));
  const group = (event: string, ref: string, channel = "", mode = "", runId = 1) => release.concurrency.group.replace(
    /\$\{\{([\s\S]*?)\}\}/g, (_match: string, expression: string) => String(runInNewContext(expression, {
      github: { event_name: event, ref, run_id: runId }, inputs: { channel, mode },
      format: (template: string, ...values: string[]) => template.replace(/\{(\d+)\}/g, (_: string, index: string) => values[Number(index)]),
    }, { timeout: 100 })));
  const dryRuns = [];
  for (const channel of ["stable", "beta", "canary", "dev"]) for (const ref of ["refs/heads/main", "refs/heads/feature"]) {
    const dry = group("workflow_dispatch", ref, channel, "dry-run"); dryRuns.push(dry);
    expect(dry).not.toBe(group("workflow_dispatch", ref, channel, "publish"));
    expect(dry).toBe(group("workflow_dispatch", ref, channel, "dry-run", 2));
    expect(group("workflow_dispatch", ref, channel, "publish")).toBe(`desktop-release-${channel}`);
  }
  expect(new Set(dryRuns).size).toBe(8);
  expect(group("push", "refs/tags/desktop-v1.0.0")).toBe("desktop-release-stable");
  expect(group("push", "refs/tags/desktop-v1.0.1")).toBe("desktop-release-stable");
  expect(group("push", "refs/tags/desktop-v1.0.0", "canary", "dry-run")).toBe("desktop-release-canary");
  expect(group("workflow_dispatch", "refs/heads/main", "canary", "publish")).toBe(canary.concurrency.group);
  expect(release.concurrency["cancel-in-progress"]).toBe(false);
});

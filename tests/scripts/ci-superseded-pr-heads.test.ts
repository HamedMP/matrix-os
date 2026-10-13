import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const changes = ci.jobs.changes;
const step = () => changes.steps.find((candidate: { id?: string }) => candidate.id === "superseded");

async function runStep(eventHead: string, live: () => Promise<{ data: { head: { sha: string } } }>) {
  const outputs: Record<string, string> = {};
  const notices: string[] = [];
  const warnings: string[] = [];
  const github = { rest: { pulls: { get: live } } };
  const context = { repo: { owner: "HamedMP", repo: "matrix-os" }, payload: { pull_request: { number: 2499, head: { sha: eventHead } } } };
  const core = { setOutput: (key: string, value: string) => { outputs[key] = String(value); }, notice: (m: string) => notices.push(m), warning: (m: string) => warnings.push(m) };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("github", "context", "core", "require", step().with.script)(github, context, core, createRequire(import.meta.url));
  return { outputs, notices, warnings };
}

describe("superseded PR head short-circuit", () => {
  it("runs only for pull_request events before change detection", () => {
    expect(step().if).toBe("github.event_name == 'pull_request'");
    const ids = changes.steps.map((candidate: { id?: string }) => candidate.id);
    expect(ids.indexOf("superseded")).toBeLessThan(ids.indexOf("changed"));
  });

  it("marks a run stale when the PR head moved past the event head", async () => {
    const result = await runStep("a".repeat(40), async () => ({ data: { head: { sha: "b".repeat(40) } } }));
    expect(result.outputs.stale).toBe("true");
    expect(result.notices.join()).toContain("superseded");
  });

  it("keeps the current head running", async () => {
    const result = await runStep("a".repeat(40), async () => ({ data: { head: { sha: "a".repeat(40) } } }));
    expect(result.outputs.stale).toBe("false");
  });

  it("never blocks CI when the PR lookup fails", async () => {
    const result = await runStep("a".repeat(40), async () => { throw new Error("API rate limit exceeded"); });
    expect(result.outputs.stale).toBe("false");
    expect(result.warnings.join()).toContain("Superseded-head check unavailable");
  });

  it("skips every heavy lane for a stale head without failing the aggregate trigger check", () => {
    const stale = "steps.superseded.outputs.stale == 'true'";
    expect(changes.outputs.should_run).toBe(`\${{ ${stale} && 'false' || steps.changed.outputs.should_run }}`);
    expect(changes.outputs.trigger_requested).toBe(`\${{ ${stale} && 'true' || steps.changed.outputs.trigger_requested }}`);
    expect(changes.outputs.docs_contract_tests).toBe(`\${{ ${stale} && 'false' || steps.changed.outputs.docs_contract_tests }}`);
    expect(changes.outputs.os_view_parity_tests).toBe(`\${{ ${stale} && 'false' || steps.changed.outputs.os_view_parity_tests }}`);
  });
});

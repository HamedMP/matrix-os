import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const workflow = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8"));
const head = "a".repeat(40);
describe("platform preview source and orchestration", () => {
  it("unrelated labels cannot cancel the active deployment, while updates and close still serialize", () => {
    const group = workflow.concurrency.group;
    const expression = group.match(/\$\{\{([\s\S]+)\}\}/)?.[1];
    expect(expression).toBeTruthy();
    const evaluate = (action: string, name: string, run_id = 10) => runInNewContext(expression, {
      github: { event_name: "pull_request", event: { action, label: { name }, pull_request: {number: 2763} }, run_id },
      inputs: {},
    });
    expect(evaluate("labeled", "preview-platform")).toBe(evaluate("synchronize", ""));
    expect(evaluate("closed", "")).toBe(evaluate("synchronize", ""));
    expect(evaluate("labeled", "ready-for-ci")).not.toBe(evaluate("labeled", "preview-platform"));
    expect(evaluate("labeled", "ready-for-ci", 11)).not.toBe(evaluate("labeled", "ready-for-ci", 10));
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
  });
  it("a manual PR dispatch checks out and names the PR commit rather than Main", async () => {
    const source = workflow.jobs.preview.steps.find((step: any) => step.id === "source");
    expect(source).toBeDefined();
    const get = vi.fn(async () => ({data: {state: "open", head: {sha: head, repo: {full_name: "HamedMP/matrix-os"}}}}));
    const core = {setOutput: vi.fn()};
    await runInNewContext(`(async()=>{${source.with.script}})()`, {
      github: {rest: {pulls: {get}}}, core,
      context: {repo: {owner: "HamedMP", repo: "matrix-os"}, payload: {inputs: {pr: "2763"}}},
    });
    expect(get).toHaveBeenCalledWith(expect.objectContaining({pull_number: 2763, request: {timeout: 15000}}));
    expect(core.setOutput).toHaveBeenCalledWith("head", head);
    const checkout = workflow.jobs.preview.steps.find((step: any) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout.with.ref).toBe("${{ steps.source.outputs.head }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
    const build = workflow.jobs.preview.steps.find((step: any) => step.name === "Build platform image");
    expect(build.run).toContain('head_sha="${{ steps.source.outputs.head }}"');
  });
  it.each(["fork", "closed", "invalid", "stale"])("rejects %s source before cloud credentials or build", async (kind) => {
    const source = workflow.jobs.preview.steps.find((step: any) => step.id === "source");
    expect(source).toBeDefined();
    const pr = {state: kind === "closed" ? "closed" : "open", head: {sha: kind === "invalid" ? "main" : head,
      repo: {full_name: kind === "fork" ? "other/matrix-os" : "HamedMP/matrix-os"}}};
    const core = {setOutput: vi.fn()};
    await expect(runInNewContext(`(async()=>{${source.with.script}})()`, {
      github: {rest: {pulls: {get: async () => ({data: pr})}}}, core,
      context: {repo: {owner: "HamedMP", repo: "matrix-os"}, payload: {pull_request: {number: 2763,
        head: {sha: kind === "stale" ? "b".repeat(40) : head}}}},
    })).rejects.toThrow();
    expect(core.setOutput).not.toHaveBeenCalled();
  });
});

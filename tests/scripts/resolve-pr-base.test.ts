import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { resolvePrBase } from "../../scripts/ci/resolve-pr-base.mjs";

// Fault this detects: in a GitHub native stack, the pull_request event's
// base_ref names the stack trunk (main), not the layer's parent branch. CI then
// measures an upper layer against main, counts every lower layer's files, and
// fails PR Size (seen on #3466: 55 files against main, 30 against its parent).

const base = {
  apiUrl: "https://api.github.com",
  repo: "HamedMP/matrix-os",
  prNumber: "3466",
  token: "t",
  fallback: "main",
};

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("resolvePrBase", () => {
  it("uses the pull request's own base branch for a stack layer", async () => {
    const fetchImpl = respond(200, { base: { ref: "eng-499-agent-inbox" } });
    const ref = await resolvePrBase({ ...base, fetchImpl, log: () => {} });
    expect(ref).toBe("eng-499-agent-inbox");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/HamedMP/matrix-os/pulls/3466");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["an HTTP error", respond(502, {})],
    ["a missing base", respond(200, {})],
    ["an unsafe ref", respond(200, { base: { ref: "main;rm -rf /" } })],
    ["a parent-path ref", respond(200, { base: { ref: "a/../b" } })],
    ["a network failure", vi.fn(async () => { throw new TypeError("fetch failed"); })],
  ])("falls back to the event base on %s and says so", async (_case, fetchImpl) => {
    const log = vi.fn();
    expect(await resolvePrBase({ ...base, fetchImpl, log })).toBe("main");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("::warning::"));
  });

  it("does not call the API without a valid pull request number", async () => {
    const fetchImpl = respond(200, { base: { ref: "other" } });
    expect(await resolvePrBase({ ...base, prNumber: "", fetchImpl, log: () => {} })).toBe("main");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid fallback instead of diffing against it", async () => {
    await expect(resolvePrBase({ ...base, fallback: "", fetchImpl: respond(200, {}), log: () => {} })).rejects.toThrow();
  });
});

describe("CI wiring", () => {
  const { jobs } = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const stepRuns = (job: string) => jobs[job].steps.map((step: { run?: string }) => step.run ?? "").join("\n");

  it.each(["pr-size", "patterns"])("%s diffs against the resolved PR base, not github.base_ref", (job) => {
    const resolver = jobs[job].steps.find((step: { id?: string }) => step.id === "pr-base");
    expect(resolver?.run).toContain("node scripts/ci/resolve-pr-base.mjs");
    expect(resolver?.env?.PR_NUMBER).toBe("${{ github.event.pull_request.number }}");
    expect(resolver?.env?.FALLBACK_BASE_REF).toBe("${{ github.base_ref }}");
    expect(stepRuns(job)).not.toMatch(/origin\/\$\{\{ github\.base_ref \}\}/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createBrainAgentReadTools } from "../../packages/gateway/src/brain/agent/index.js";
import { BrainApiError, type BrainProjectService } from "../../packages/gateway/src/brain/api/index.js";
import {
  BrainFeatureError, type BrainAgentReadToolsDeps, type BrainBriefService, type BrainGraphService,
  type BrainImpactService, type BrainSearchService,
} from "../../packages/gateway/src/brain/contracts.js";
import { BrainStoreError } from "../../packages/gateway/src/brain/index.js";
import type { BrainAgentReadTools as KernelBrainAgentReadTools } from "../../packages/kernel/src/tools/brain-read-tools.js";

const VIEW = { items: [], nextCursor: null };

function services() {
  const search = { search: vi.fn(async () => ({ ...VIEW, q: "x" })), refresh: vi.fn(), capability: vi.fn() };
  const graph = {
    timeline: vi.fn(async () => ({ ...VIEW, entity: { entityId: "e" } })), listEntities: vi.fn(), getEntity: vi.fn(),
    links: vi.fn(), updateAlias: vi.fn(), mergeSuggestions: vi.fn(), refresh: vi.fn(),
  };
  const project = {
    registerGitSource: vi.fn(), sync: vi.fn(), listReceipts: vi.fn(), why: vi.fn(), extract: vi.fn(),
    listClaims: vi.fn(async () => ({ ...VIEW, kind: null, path: null, match: null })),
  };
  const brief = {
    getBrief: vi.fn(async () => ({ date: "2026-10-01" })), generateBrief: vi.fn(), stale: vi.fn(),
    conflicts: vi.fn(async () => VIEW),
  };
  const impact = { impact: vi.fn(async () => ({ changedTotal: 0 })), comment: vi.fn() };
  return { search, graph, project, brief, impact };
}

function depsOf(fakes: ReturnType<typeof services>, ownerId: string | null = "owner_a"): BrainAgentReadToolsDeps {
  return {
    ownerId,
    project: fakes.project as unknown as BrainProjectService,
    search: fakes.search as unknown as BrainSearchService,
    graph: fakes.graph as unknown as BrainGraphService,
    brief: fakes.brief as unknown as BrainBriefService,
    impact: fakes.impact as unknown as BrainImpactService,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("createBrainAgentReadTools", () => {
  it("is undefined without an owner or without any service, and has a method only per service", () => {
    const fakes = services();
    expect(createBrainAgentReadTools(depsOf(fakes, null))).toBeUndefined();
    expect(createBrainAgentReadTools({ ownerId: "owner_a", project: null, search: null, graph: null, brief: null, impact: null }))
      .toBeUndefined();
    const all = createBrainAgentReadTools(depsOf(fakes));
    expect(Object.keys(all ?? {}).sort()).toEqual(["brief", "claims", "conflicts", "impact", "search", "timeline"]);
    const claimsOnly = createBrainAgentReadTools({ ...depsOf(fakes), search: null, graph: null, brief: null, impact: null });
    expect(Object.keys(claimsOnly ?? {})).toEqual(["claims"]);
    const noProject = createBrainAgentReadTools({ ...depsOf(fakes), project: null });
    expect(Object.keys(noProject ?? {}).sort()).toEqual(["brief", "conflicts", "impact", "search", "timeline"]);
    // The kernel registers the gateway object as its structural mirror.
    const kernel: KernelBrainAgentReadTools | undefined = all;
    expect(kernel).toBe(all);
  });

  it("calls each service as the bound owner with defaulted, capped limits and only the given filters", async () => {
    const fakes = services();
    const tools = createBrainAgentReadTools(depsOf(fakes))!;
    expect(await tools.search!({ project: "matrix-os", query: "bounded" })).toMatchObject({ status: "ok", q: "x" });
    expect(fakes.search.search).toHaveBeenLastCalledWith("owner_a", "matrix-os", { q: "bounded", mode: "auto", limit: 8 });
    await tools.search!({
      project: "proj_a", query: "q", kinds: ["pr"], claimKinds: ["risk"], path: "src/", from: "2026-01-01",
      to: "2026-02-01", limit: 99, cursor: "c1",
    });
    expect(fakes.search.search).toHaveBeenLastCalledWith("owner_a", "proj_a", {
      q: "q", mode: "auto", limit: 20, kinds: ["pr"], claimKinds: ["risk"], path: "src/", from: "2026-01-01",
      to: "2026-02-01", cursor: "c1",
    });

    expect(await tools.timeline!({ project: "p", entity: "file:a.ts", limit: 0, cursor: "t" }))
      .toMatchObject({ status: "ok", entity: { entityId: "e" } });
    expect(fakes.graph.timeline).toHaveBeenLastCalledWith("owner_a", "p", { entity: "file:a.ts", limit: 10, cursor: "t" });
    await tools.timeline!({ project: "p", entity: "file:a.ts", limit: 2.5 });
    expect(fakes.graph.timeline).toHaveBeenLastCalledWith("owner_a", "p", { entity: "file:a.ts", limit: 10 });

    expect(await tools.claims!({ project: "p", kind: "decision", path: "src", limit: 7, cursor: "k" }))
      .toMatchObject({ status: "ok", kind: null });
    expect(fakes.project.listClaims).toHaveBeenLastCalledWith("owner_a", "p", { limit: 7, kind: "decision", path: "src", cursor: "k" });
    await tools.claims!({ project: "p" });
    expect(fakes.project.listClaims).toHaveBeenLastCalledWith("owner_a", "p", { limit: 10 });

    expect(await tools.brief!({ project: "p" })).toEqual({ status: "ok", date: "2026-10-01" });
    expect(fakes.brief.getBrief).toHaveBeenLastCalledWith("owner_a", "p", {});
    await tools.brief!({ project: "p", date: "2026-09-30", window: "week" });
    expect(fakes.brief.getBrief).toHaveBeenLastCalledWith("owner_a", "p", { date: "2026-09-30", window: "week" });

    expect(await tools.conflicts!({ project: "p", limit: 50, cursor: "z" })).toEqual({ status: "ok", ...VIEW });
    expect(fakes.brief.conflicts).toHaveBeenLastCalledWith("owner_a", "p", { limit: 20, cursor: "z" });
    await tools.conflicts!({ project: "p" });
    expect(fakes.brief.conflicts).toHaveBeenLastCalledWith("owner_a", "p", { limit: 10 });

    expect(await tools.impact!({ project: "p", head: "feature/x" })).toEqual({ status: "ok", changedTotal: 0 });
    expect(fakes.impact.impact).toHaveBeenLastCalledWith("owner_a", "p", { head: "feature/x" });
    await tools.impact!({ project: "p", head: "abc1234", base: "main", depth: 2 });
    expect(fakes.impact.impact).toHaveBeenLastCalledWith("owner_a", "p", { head: "abc1234", base: "main", depth: 2 });
  });

  it("maps failures to fixed statuses and logs only error names", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const statusFor = async (thrown: unknown) => {
      const fakes = services();
      fakes.search.search.mockImplementation(async () => { throw thrown; });
      return (await createBrainAgentReadTools(depsOf(fakes))!.search!({ project: "p", query: "q" })).status;
    };
    expect(await statusFor(new BrainApiError("project_not_found"))).toBe("not_found");
    expect(await statusFor(new BrainFeatureError("entity_not_found"))).toBe("not_found");
    expect(await statusFor(new BrainFeatureError("git_ref_not_found"))).toBe("not_found");
    expect(await statusFor(new BrainApiError("invalid_request"))).toBe("invalid");
    expect(await statusFor(new BrainStoreError("invalid"))).toBe("invalid");
    expect(await statusFor(z.string().safeParse(1).error)).toBe("invalid");
    expect(await statusFor(new BrainFeatureError("vector_search_unavailable"))).toBe("not_configured");
    expect(await statusFor(new BrainFeatureError("summary_not_configured"))).toBe("not_configured");
    expect(error).not.toHaveBeenCalled();
    expect(await statusFor(new BrainApiError("brain_unavailable"))).toBe("unavailable");
    expect(error).toHaveBeenLastCalledWith("[brain-agent] brain_search failed:", "BrainApiError");
    expect(await statusFor(new BrainFeatureError("source_conflict"))).toBe("unavailable");
    expect(await statusFor(new BrainStoreError("conflict"))).toBe("unavailable");
    expect(await statusFor(new Error("relation brain_documents at /home/matrix"))).toBe("unavailable");
    expect(error).toHaveBeenLastCalledWith("[brain-agent] brain_search failed:", "Error");
    expect(await statusFor("boom")).toBe("unavailable");
    expect(error).toHaveBeenLastCalledWith("[brain-agent] brain_search failed:", "string");
    expect(JSON.stringify(error.mock.calls)).not.toContain("/home/matrix");
  });
});

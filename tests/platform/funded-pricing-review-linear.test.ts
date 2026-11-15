import { describe, expect, it, vi } from "vitest";
import { createFundedPricingReviewLinear } from "../../packages/platform/src/funded-pricing-review-linear.js";

const teamId = "2e8af043-5f4c-4f99-856d-2baf445bf9db";
const openStateId = "043ac9d6-942d-4f62-b522-1e90fcfb0e30";
const completedStateId = "7d58bc30-4486-4d20-81d6-f0ed2a27a8bb";
const input = {
  key: "@cf/zai-org/glm-5.3",
  title: "Funded AI pricing review needs attention",
  description: "The verified renewal deadline is 2026-11-14T00:00:00.000Z.",
  priority: 3 as const,
  deadline: "2026-11-14T00:00:00.000Z",
};
const signal = new AbortController().signal;

describe("Funded AI Linear alerts", () => {
  it("uses one stable Engineering issue for retries, escalation and recovery", async () => {
    let issue: Record<string, unknown> | undefined;
    const comments: string[] = [];
    const writes: { operation: string; id: string; input: Record<string, unknown> }[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.linear.app/graphql");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("Authorization")).toBe("lin_api_test_credential");
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes("team(id:")) return Response.json({ data: {
        team: { id: teamId, key: "ENG", states: { nodes: [
          { id: openStateId, type: "unstarted" }, { id: completedStateId, type: "completed" },
        ] } },
      } });
      if (query.includes("comments(")) return Response.json({ data: { comments: {
        nodes: comments.includes(variables.id) ? [{ id: variables.id, issue: { id: issue?.id } }] : [],
      } } });
      if (query.includes("commentCreate(")) {
        comments.push(variables.input.id);
        return Response.json({ data: { commentCreate: { success: true, comment: { id: variables.input.id } } } });
      }
      if (query.includes("issues(")) return Response.json({ data: { issues: { nodes: issue ? [issue] : [] } } });
      const operation = query.includes("issueCreate(") ? "issueCreate" : "issueUpdate";
      const id = variables.id ?? variables.input.id;
      writes.push({ operation, id, input: variables.input });
      issue = {
        ...issue, id, team: { id: teamId }, description: variables.input.description ?? issue?.description,
        priority: variables.input.priority ?? issue?.priority,
        state: { id: variables.input.stateId ?? (issue?.state as { id: string } | undefined)?.id ?? openStateId },
      };
      return Response.json({ data: { [operation]: { success: true, issue: { id } } } });
    });
    const sink = createFundedPricingReviewLinear({ apiKey: "lin_api_test_credential", teamId, openStateId, completedStateId, fetchFn });
    await sink.notify(input, signal);
    await sink.notify(input, signal);
    await sink.notify({ ...input, priority: 2 }, signal);
    await sink.notify({ ...input, priority: 1 }, signal);
    await sink.notify(input, signal);
    await sink.resolve(input.key, signal);
    await sink.resolve(input.key, signal);

    expect(writes.map((entry) => entry.operation)).toEqual(["issueCreate", "issueUpdate", "issueUpdate", "issueUpdate"]);
    expect(writes[0].input).toMatchObject({ teamId, stateId: openStateId, priority: 3 });
    expect(writes.slice(1, 3).map((entry) => entry.input.priority)).toEqual([2, 1]);
    expect(writes[3].input).toMatchObject({ stateId: completedStateId });
    expect(new Set(writes.map((entry) => entry.id)).size).toBe(1);
    expect(new Set(comments).size).toBe(2);
    expect(comments).toHaveLength(2);
  });

  it("refuses a different Linear destination without looking up or writing an issue", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: {
      team: { id: teamId, key: "PROD", states: { nodes: [
        { id: openStateId, type: "unstarted" }, { id: completedStateId, type: "completed" },
      ] } },
    } }));
    const sink = createFundedPricingReviewLinear({ apiKey: "lin_api_test_credential", teamId, openStateId, completedStateId, fetchFn });
    await expect(sink.notify(input, signal)).rejects.toThrow("Linear Engineering alert destination is invalid");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects GraphQL errors instead of creating an issue after an ambiguous lookup", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      JSON.parse(String(init?.body)).query.includes("team(id:")
        ? Response.json({ data: { team: { id: teamId, key: "ENG", states: { nodes: [
          { id: openStateId, type: "unstarted" }, { id: completedStateId, type: "completed" },
        ] } } } })
        : Response.json({ data: { issues: { nodes: [] } }, errors: [{ message: "permission denied" }] }));

    const sink = createFundedPricingReviewLinear({ apiKey: "lin_api_test_credential", teamId, openStateId, completedStateId, fetchFn });
    await expect(sink.notify(input, signal)).rejects.toThrow("Linear pricing alert lookup failed");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

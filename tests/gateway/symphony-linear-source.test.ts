import { describe, expect, it, vi } from "vitest";
import { createLinearSource } from "../../packages/gateway/src/symphony/linear-source.js";

const rule = {
  installationId: "sym_user_123",
  teamId: "team_123",
  teamKey: "MAT",
  requiredLabels: ["symphony", "urgent"],
  activeStates: ["Todo"],
  terminalStates: ["Done"],
  assigneeIds: ["assignee_1"],
  updatedAt: "2026-05-13T00:00:00.000Z",
};

describe("Symphony Linear source", () => {
  it("filters by assignee and required labels without exposing the credential", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeTruthy();
      expect(init.headers).toMatchObject({ Authorization: "lin_api_secret" });
      const body = JSON.parse(String(init.body));
      expect(body.variables.assigneeId).toBe("assignee_1");
      return new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [
              {
                id: "issue_1",
                identifier: "MAT-1",
                title: "Run Symphony",
                url: "https://linear.app/acme/issue/MAT-1",
                assignee: { id: "assignee_1", displayName: "Hamed" },
                state: { name: "Todo", type: "unstarted" },
                team: { id: "team_123", key: "MAT" },
                labels: { nodes: [{ name: "symphony" }, { name: "urgent" }] },
                project: { id: "project_1", slugId: "matrix-os" },
              },
              {
                id: "issue_2",
                identifier: "MAT-2",
                title: "Wrong label",
                assignee: { id: "assignee_1" },
                state: { name: "Todo" },
                labels: { nodes: [{ name: "symphony" }] },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      }));
    }) as unknown as typeof fetch;
    const source = createLinearSource({ fetch: fetchMock });

    const result = await source.previewTickets(rule, "lin_api_secret", { limit: 10 });

    expect(result.tickets).toEqual([
      expect.objectContaining({ externalId: "issue_1", identifier: "MAT-1", assigneeId: "assignee_1" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("lin_api_secret");
  });

  it("uses no assignee filter when assigneeIds is empty", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.variables).not.toHaveProperty("assigneeId");
      return new Response(JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } }));
    }) as unknown as typeof fetch;
    const source = createLinearSource({ fetch: fetchMock });

    await source.previewTickets({ ...rule, assigneeIds: [] }, "lin_api_secret");

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not mark an exact-limit exhaustive preview as truncated", async () => {
    const nodes = Array.from({ length: 100 }, (_unused, index) => ({
      id: `issue_${index}`,
      identifier: `MAT-${index}`,
      title: `Ticket ${index}`,
      assignee: { id: "assignee_1" },
      state: { name: "Todo" },
      labels: { nodes: [{ name: "symphony" }, { name: "urgent" }] },
    }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        issues: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }))) as unknown as typeof fetch;
    const source = createLinearSource({ fetch: fetchMock });

    const result = await source.previewTickets(rule, "lin_api_secret", { limit: 100 });

    expect(result.tickets).toHaveLength(100);
    expect(result.truncated).toBe(false);
  });

  it("uses one broad Linear query for large state and assignee rule sets", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.variables).not.toHaveProperty("state");
      expect(body.variables).not.toHaveProperty("assigneeId");
      return new Response(JSON.stringify({
      data: {
        issues: {
          nodes: [
            {
              id: "issue_late",
              identifier: "MAT-999",
              title: "Eligible later combination",
              assignee: { id: "assignee_49" },
              state: { name: "State 19" },
              labels: { nodes: [{ name: "symphony" }, { name: "urgent" }] },
            },
            {
              id: "issue_wrong_state",
              identifier: "MAT-998",
              title: "Wrong state",
              assignee: { id: "assignee_49" },
              state: { name: "Backlog" },
              labels: { nodes: [{ name: "symphony" }, { name: "urgent" }] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }));
    }) as unknown as typeof fetch;
    const source = createLinearSource({ fetch: fetchMock });

    const result = await source.previewTickets({
      ...rule,
      activeStates: Array.from({ length: 20 }, (_unused, index) => `State ${index}`),
      assigneeIds: Array.from({ length: 50 }, (_unused, index) => `assignee_${index}`),
    }, "lin_api_secret", { limit: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      truncated: false,
      tickets: [expect.objectContaining({ externalId: "issue_late", identifier: "MAT-999" })],
    });
  });

  it("pages through Linear results before applying remaining label filters", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.variables.after === null) {
        return new Response(JSON.stringify({
          data: {
            issues: {
              nodes: [{
                id: "issue_1",
                identifier: "MAT-1",
                title: "Wrong label first page",
                assignee: { id: "assignee_1" },
                state: { name: "Todo" },
                labels: { nodes: [{ name: "symphony" }] },
              }],
              pageInfo: { hasNextPage: true, endCursor: "cursor_1" },
            },
          },
        }));
      }
      expect(body.variables.after).toBe("cursor_1");
      return new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [{
              id: "issue_2",
              identifier: "MAT-2",
              title: "Eligible second page",
              assignee: { id: "assignee_1" },
              state: { name: "Todo" },
              labels: { nodes: [{ name: "symphony" }, { name: "urgent" }] },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }));
    }) as unknown as typeof fetch;
    const source = createLinearSource({ fetch: fetchMock });

    const result = await source.previewTickets(rule, "lin_api_secret", { limit: 10 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      truncated: false,
      tickets: [expect.objectContaining({ externalId: "issue_2", identifier: "MAT-2" })],
    });
  });
});

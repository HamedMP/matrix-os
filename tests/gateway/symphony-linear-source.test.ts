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
  it("can execute Linear GraphQL through a server-side integration transport", async () => {
    const graphql = vi.fn(async ({ query, variables, credential }) => {
      expect(credential).toBe("matrixos_linear_integration");
      expect(query).toContain("MatrixSymphonySetupOptions");
      expect(variables).toMatchObject({ first: 100, includeTeams: true });
      return {
        data: {
          teams: { nodes: [{ id: "team_123", key: "MAT", name: "Matrix" }], pageInfo: { hasNextPage: false, endCursor: null } },
          projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          users: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      };
    });
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const source = createLinearSource({ fetch: fetchMock, graphql });

    const result = await source.discoverSetupOptions("matrixos_linear_integration");

    expect(result.teams).toEqual([{ id: "team_123", key: "MAT", name: "Matrix" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discovers teams, projects, and users without exposing the credential", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeTruthy();
      expect(init.headers).toMatchObject({ Authorization: "lin_api_secret" });
      const body = JSON.parse(String(init.body));
      expect(body.query).toContain("MatrixSymphonySetupOptions");
      expect(body.query).not.toContain("email");
      return new Response(JSON.stringify({
        data: {
          teams: { nodes: [{ id: "team_123", key: "MAT", name: "Matrix" }], pageInfo: { hasNextPage: false, endCursor: null } },
          projects: {
            nodes: [{
              id: "linear_project_1",
              name: "Matrix OS",
              slugId: "matrix-os",
              teams: { nodes: [{ id: "team_123", key: "MAT", name: "Matrix" }] },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          users: { nodes: [{ id: "user_1", name: "Hamed", displayName: "Hamed", active: true }], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      }));
    }) as unknown as typeof fetch;
    const source = createLinearSource({ fetch: fetchMock });

    const result = await source.discoverSetupOptions("lin_api_secret");

    expect(result).toEqual({
      teams: [{ id: "team_123", key: "MAT", name: "Matrix" }],
      projects: [{ id: "linear_project_1", name: "Matrix OS", slug: "matrix-os", teamIds: ["team_123"] }],
      users: [{ id: "user_1", name: "Hamed", displayName: "Hamed", active: true }],
    });
    expect(JSON.stringify(result)).not.toContain("lin_api_secret");
    expect(JSON.stringify(result)).not.toContain("hamed@example.com");
  });

  it("pages through Linear setup options before returning selectors", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.variables.usersAfter === null) {
        return new Response(JSON.stringify({
          data: {
            teams: { nodes: [{ id: "team_123", key: "MAT", name: "Matrix" }], pageInfo: { hasNextPage: false, endCursor: null } },
            projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            users: { nodes: [{ id: "user_1", name: "First" }], pageInfo: { hasNextPage: true, endCursor: "user_cursor_1" } },
          },
        }));
      }
      expect(body.variables).toMatchObject({
        includeTeams: false,
        includeProjects: false,
        includeUsers: true,
        usersAfter: "user_cursor_1",
      });
      return new Response(JSON.stringify({
        data: {
          users: { nodes: [{ id: "user_2", name: "Second" }], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      }));
    }) as unknown as typeof fetch;
    const source = createLinearSource({ fetch: fetchMock });

    const result = await source.discoverSetupOptions("lin_api_secret");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.users).toEqual([
      { id: "user_1", name: "First", displayName: undefined, active: undefined },
      { id: "user_2", name: "Second", displayName: undefined, active: undefined },
    ]);
  });

  it("filters by assignee and required labels without exposing the credential", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeTruthy();
      expect(init.headers).toMatchObject({ Authorization: "lin_api_secret" });
      const body = JSON.parse(String(init.body));
      expect(body.query).toContain("$teamId: ID!");
      expect(body.query).toContain("$projectId: ID!");
      expect(body.query).toContain("$assigneeId: ID!");
      expect(body.query).toContain("$state: String!");
      expect(body.query).not.toContain("$labelName: String!");
      expect(body.variables.assigneeId).toBe("assignee_1");
      expect(body.variables).not.toHaveProperty("labelName");
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

    const result = await source.previewTickets({ ...rule, projectId: "project_1" }, "lin_api_secret", { limit: 10 });

    expect(result.tickets).toEqual([
      expect.objectContaining({ externalId: "issue_1", identifier: "MAT-1", assigneeId: "assignee_1" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("lin_api_secret");
  });

  it("fetches candidates without server-side label narrowing so new labels are detected reliably", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.query).not.toContain("$labelName");
      expect(body.query).not.toContain("labels: { name:");
      expect(body.variables).not.toHaveProperty("labelName");
      return new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [{
              id: "issue_1",
              identifier: "MAT-1",
              title: "Newly labeled",
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

    expect(result.tickets).toEqual([expect.objectContaining({ externalId: "issue_1" })]);
  });

  it("shares scan offsets across rules that only differ by required labels", async () => {
    const statesSeen: string[] = [];
    const graphql = vi.fn(async ({ variables }) => {
      const state = String(variables?.state);
      statesSeen.push(state);
      const label = statesSeen.length === 1 ? "symphony" : "urgent";
      return {
        data: {
          issues: {
            nodes: [{
              id: `issue_${statesSeen.length}`,
              identifier: `MAT-${statesSeen.length}`,
              title: state,
              assignee: { id: "assignee_1" },
              state: { name: state },
              labels: { nodes: [{ name: label }] },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });
    const source = createLinearSource({ graphql });
    const twoStateRule = { ...rule, requiredLabels: ["symphony"], activeStates: ["Todo", "In Progress"] };

    await source.previewTickets(twoStateRule, "lin_api_secret", { limit: 1 });
    await source.previewTickets({ ...twoStateRule, requiredLabels: ["urgent"] }, "lin_api_secret", { limit: 1 });

    expect(statesSeen).toEqual(["Todo", "In Progress"]);
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

  it("marks an exact-limit preview as truncated when Linear has another page", async () => {
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
          pageInfo: { hasNextPage: true, endCursor: "cursor_1" },
        },
      },
    }))) as unknown as typeof fetch;
    const source = createLinearSource({ fetch: fetchMock });

    const result = await source.previewTickets(rule, "lin_api_secret", { limit: 100 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.tickets).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it("rotates broad rule scans beyond the per-poll request cap", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const state = body.variables.state;
      return new Response(JSON.stringify({
      data: {
        issues: {
          nodes: state === "State 20" ? [
            {
              id: "issue_late",
              identifier: "MAT-999",
              title: "Eligible later combination",
              state: { name: "State 20" },
              labels: { nodes: [{ name: "symphony" }, { name: "urgent" }] },
            },
          ] : [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }));
    }) as unknown as typeof fetch;
    const source = createLinearSource({ fetch: fetchMock });

    const broadRule = {
      ...rule,
      activeStates: Array.from({ length: 21 }, (_unused, index) => `State ${index}`),
      assigneeIds: [],
    };

    const first = await source.previewTickets(broadRule, "lin_api_secret", { limit: 100 });
    const second = await source.previewTickets(broadRule, "lin_api_secret", { limit: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(40);
    expect(first).toMatchObject({ tickets: [], truncated: true });
    expect(second).toMatchObject({
      truncated: true,
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

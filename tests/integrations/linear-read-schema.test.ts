import { readFileSync } from "node:fs";
import { buildSchema, graphql, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { getAction } from "../../packages/gateway/src/integrations/registry.js";

const schema = buildSchema(readFileSync(
  new URL("../fixtures/linear-read-schema.graphql", import.meta.url), "utf8",
));

function queryBody(action: string, params: Record<string, unknown>) {
  const directApi = getAction("linear", action)!.directApi!;
  return directApi.mapBody!(params) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

describe("Linear read GraphQL schema contract", () => {
  it.each([
    ["project", { projectId: "project-fixture" }],
    ["team", { teamId: "team-fixture" }],
    ["both IDs", { teamId: "team-fixture", projectId: "project-fixture" }],
    ["state and label names", { state: "In Progress", labelName: "launch" }],
    ["all filters and cursor", {
      teamId: "team-fixture", projectId: "project-fixture",
      state: "In Progress", labelName: "launch", after: "cursor-fixture", first: 1,
    }],
    ["unfiltered", {}],
    ["empty optional filters", {
      teamId: " ", projectId: " ", state: " ", labelName: " ", after: " ",
    }],
  ])("validates the generated %s issue query against provider types", (_name, params) => {
    const body = queryBody("list_issues", params);
    expect(validate(schema, parse(body.query)).map(error => error.message)).toEqual([]);
  });

  it("validates team-scoped workflow-state reads against provider ID filters", () => {
    const body = queryBody("list_workflow_states", { teamId: "team-fixture", first: 1 });
    expect(validate(schema, parse(body.query)).map(error => error.message)).toEqual([]);
  });

  it("coerces filter variables and preserves scope, cursor and page bounds at execution", async () => {
    const params = {
      teamId: "team-fixture", projectId: "project-fixture",
      state: 'In "Progress"', labelName: "launch", after: "cursor-fixture", first: 1000,
    };
    const body = queryBody("list_issues", params);
    let received: unknown;
    const result = await graphql({
      schema, source: body.query, variableValues: body.variables,
      rootValue: { issues: (args: unknown) => {
        received = args;
        return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      } },
    });
    expect(result.errors).toBeUndefined();
    expect(received).toEqual({
      first: 100, after: params.after, orderBy: "updatedAt",
      filter: {
        team: { id: { eq: params.teamId } }, project: { id: { eq: params.projectId } },
        state: { name: { eq: params.state } }, labels: { name: { eq: params.labelName } },
      },
    });
  });

  it("coerces required workflow team scope without widening the read", async () => {
    const body = queryBody("list_workflow_states", { teamId: "team-fixture", first: 1000 });
    let received: unknown;
    const result = await graphql({
      schema, source: body.query, variableValues: body.variables,
      rootValue: { workflowStates: (args: unknown) => {
        received = args;
        return { nodes: [] };
      } },
    });
    expect(result.errors).toBeUndefined();
    expect(received).toEqual({ first: 100, filter: { team: { id: { eq: "team-fixture" } } } });
  });
});

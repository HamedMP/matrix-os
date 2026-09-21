import { describe, it, expect } from "vitest";
import { getAction } from "../../packages/gateway/src/integrations/registry.js";
import { validateActionParams } from "../../packages/gateway/src/integrations/parameter-validation.js";

describe("Symphony typed Linear contract", () => {
  it("exposes fixed bounded operations and never arbitrary GraphQL", () => {
    expect(getAction("linear", "graphql")).toBeUndefined();
    const action = getAction("linear", "symphony_poll");
    expect(action).toBeDefined();
    const params = { projectSlug: "my-project", stateNames: ["Todo"], first: 50, relationFirst: 50, after: null };
    expect(validateActionParams(action!, params).valid).toBe(true);
    const body = action!.directApi!.mapBody!(params);
    expect(body.query).toContain("query SymphonyLinearPoll");
    expect(body.variables).toEqual(params);
    for (const bad of [{ ...params, query: "mutation { anything }" }, { ...params, first: 10000 },
      { ...params, stateNames: Array(51).fill("Todo") }, { ...params, projectSlug: "" }]) {
      expect(validateActionParams(action!, bad).valid).toBe(false);
    }
  });

  it("supports issue reconciliation, viewer lookup, comments and state changes with strict schemas", () => {
    for (const [id, params] of Object.entries({
      symphony_issues_by_id: { ids: ["abc"], first: 1, relationFirst: 50 },
      symphony_viewer: {},
      symphony_get_issue: { issueId: "abc" },
      symphony_update_comment: { id: "abc", body: "Updated workpad" },
      symphony_create_comment: { issueId: "abc", body: "Working on it" },
      symphony_resolve_state: { issueId: "abc", stateName: "Done" },
      symphony_update_state: { issueId: "abc", stateId: "def" },
    })) {
      const action = getAction("linear", id)!;
      expect(action, id).toBeDefined();
      expect(validateActionParams(action, params).valid).toBe(true);
      expect(validateActionParams(action, { ...params, query: "anything" }).valid).toBe(false);
      expect(action.directApi!.mapBody!(params).variables).toEqual(params);
    }
  });
});

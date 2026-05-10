import { describe, expect, it } from "vitest";
import { getAction } from "../../packages/gateway/src/integrations/registry.js";
import { validateActionParams } from "../../packages/gateway/src/integrations/routes.js";

describe("integrations registry", () => {
  it("passes Linear label IDs as an array", () => {
    const action = getAction("linear", "create_issue");
    expect(action).toBeDefined();
    const params = {
      teamId: "team_mat",
      title: "Follow up",
      labelIds: ["label_symphony", "label_urgent"],
    };

    expect(validateActionParams(action!, params)).toEqual({ valid: true });
    const body = action!.directApi?.mapBody?.(params);

    expect(body).toMatchObject({
      variables: {
        input: {
          teamId: "team_mat",
          title: "Follow up",
          labelIds: ["label_symphony", "label_urgent"],
        },
      },
    });
  });

  it("rejects comma-delimited Linear label IDs", () => {
    const action = getAction("linear", "create_issue");
    expect(action).toBeDefined();

    expect(validateActionParams(action!, {
      teamId: "team_mat",
      title: "Follow up",
      labelIds: "label_symphony,label_urgent",
    })).toEqual({
      valid: false,
      missing: [],
      typeErrors: ["labelIds: expected array, got string"],
    });
  });

  it("omits the Linear label comparator when no label name is requested", () => {
    const action = getAction("linear", "list_issues");
    expect(action).toBeDefined();

    const body = action!.directApi?.mapBody?.({ teamId: "team_mat", first: 25 }) as {
      query: string;
      variables: Record<string, unknown>;
    };

    expect(body.query).not.toContain("labels:");
    expect(body.query).not.toContain("$labelName");
    expect(body.variables).not.toHaveProperty("labelName");
  });

  it("includes the Linear label comparator when a label name is requested", () => {
    const action = getAction("linear", "list_issues");
    expect(action).toBeDefined();

    const body = action!.directApi?.mapBody?.({ teamId: "team_mat", labelName: "symphony", first: 25 }) as {
      query: string;
      variables: Record<string, unknown>;
    };

    expect(body.query).toContain("labels: { name: { eq: $labelName } }");
    expect(body.variables).toMatchObject({ labelName: "symphony" });
  });
});

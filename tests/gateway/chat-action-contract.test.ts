import { describe, expect, it } from "vitest";
import { CanonicalChatRunPolicySchema } from "@matrix-os/contracts";
import { CanonicalOperationSchema, BoundedActionJsonSchema } from "../../packages/contracts/src/canonical-action.js";

describe("canonical action contracts", () => {
  const policy = { memoryMode: "ordinary", source: "typed", nativeCheckpointPolicy: "reusable", executionPolicy: { revision: "actions_v1", actionMode: "safe_reads", workspaceScope: "apps", tools: ["matrix_list_apps"], delegation: false } };
  it("accepts strict bounded execution policy and rejects duplicate inventory", () => {
    expect(CanonicalChatRunPolicySchema.safeParse(policy).success).toBe(true);
    expect(CanonicalChatRunPolicySchema.safeParse({ ...policy, executionPolicy: { ...policy.executionPolicy, tools: ["matrix_list_apps", "matrix_list_apps"] } }).success).toBe(false);
    expect(CanonicalChatRunPolicySchema.safeParse({ ...policy, executionPolicy: { ...policy.executionPolicy, clientApproved: true } }).success).toBe(false);
  });
  it("bounds JSON bytes, rejects undefined and nonfinite values", () => {
    expect(BoundedActionJsonSchema.safeParse({ x: "x".repeat(65_536) }).success).toBe(false);
    expect(BoundedActionJsonSchema.safeParse({ x: undefined }).success).toBe(false);
    expect(BoundedActionJsonSchema.safeParse({ x: Infinity }).success).toBe(false);
  });
  it("requires a canonical operation identity", () => {
    expect(CanonicalOperationSchema.safeParse({ id: "native_tool" }).success).toBe(false);
  });
});

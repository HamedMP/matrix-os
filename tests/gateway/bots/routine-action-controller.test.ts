import { describe, expect, it } from "vitest";
import { routineActionPolicy, createRoutineActionSourceRegistry } from "../../../packages/gateway/src/bots/routine-action-source-registry.js";
import { context } from "./routine-cli-source-support.js";
const policy = { live: true, scope: "personal", interactionMode: "default", permissionMode: "full_access", originCeiling: "full", revision: "policy_1" } as const;
const terminal = { ...context(), identity: { kind: "terminal_launch", sessionId: "s", incarnationId: "i", launchId: "l" } } as const;
describe("host routine source registry/current policy", () => {
  it("applies trusted personal Full Access to exact Chat and Terminal operations", () => {
    for (const source of [context(), terminal]) {
      expect(routineActionPolicy(source, policy, "propose")).toBe("allow");
      expect(routineActionPolicy(source, policy, "control")).toBe("allow");
      for (const permissionMode of ["supervised", "auto", "auto_accept_edits"] as const)
        expect(routineActionPolicy(source, { ...policy, permissionMode }, "control")).toBe("ask");
      expect(routineActionPolicy(source, { ...policy, originCeiling: "exact" }, "control")).toBe("ask");
    }
  });
  it("neither Terminal defaults nor owner cards override plan/review/shared/org/read ceilings or dead sources", () => {
    for (const source of [context(), terminal]) {
      for (const patch of [{ interactionMode: "plan" }, { interactionMode: "review" }, { scope: "shared" }, { scope: "org" },
        { originCeiling: "read" }, { live: false }, { permissionMode: "unsupported" }])
        expect(routineActionPolicy(source, { ...policy, ...patch } as typeof policy, "propose")).toBe("deny");
    }
  });
  it("unknown, replaced, aborted and expired producer handles deny; shutdown drains", () => {
    let time = Date.parse(context().issuedAt);
    const registry = createRoutineActionSourceRegistry({ now: () => time, maxSources: 1 });
    const abort = new AbortController();
    const first = registry.register({ source: context(), readPolicy: () => policy, validateWithin: async () => true, signal: abort.signal });
    expect(registry.read(context())?.policy).toEqual(policy);
    expect(registry.read({ ...context(), generation: "forged" })).toBeNull();
    expect(() => registry.register({ source: { ...context(), generation: "two" }, readPolicy: () => policy, validateWithin: async () => true, signal: abort.signal })).toThrow();
    abort.abort(); expect(registry.read(context())).toBeNull(); expect(first.signal.aborted).toBe(true);
    const second = registry.register({ source: context("two"), readPolicy: () => policy, validateWithin: async () => true, signal: new AbortController().signal });
    time += 300_001; expect(registry.read(context("two"))).toBeNull(); expect(second.signal.aborted).toBe(true);
    registry.close(); expect(() => registry.register({ source: context(), readPolicy: () => policy, validateWithin: async () => true, signal: new AbortController().signal })).toThrow();
  });
});
it("rotating the same trusted native source generation closes its older pending handle", () => {
  const registry = createRoutineActionSourceRegistry({ now: () => Date.parse(context().issuedAt) });
  try {
    const old = registry.register({ source: context(), readPolicy: () => policy, validateWithin: async () => true, signal: new AbortController().signal });
    const next = registry.register({ source: context("next_generation"), readPolicy: () => policy, validateWithin: async () => true, signal: new AbortController().signal });
    expect(old.signal.aborted).toBe(true); expect(registry.has(old)).toBe(false); expect(registry.has(next)).toBe(true);
  } finally { registry.close(); }
});

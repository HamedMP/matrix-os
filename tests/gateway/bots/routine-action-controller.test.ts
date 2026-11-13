import { describe, expect, it } from "vitest";
import { routineActionPolicy, createRoutineActionSourceRegistry } from "../../../packages/gateway/src/bots/routine-action-source-registry.js";
import { context } from "./routine-cli-source-support.js";
const policy = { live: true, scope: "personal", interactionMode: "default", permissionMode: "full_access", originCeiling: "full", revision: "policy_1" } as const;
describe("host routine source registry/current policy", () => {
  it("maps only actual full-access default personal ceilings; terminal always asks", () => {
    expect(routineActionPolicy(context(), policy, "propose")).toBe("allow");
    expect(routineActionPolicy({ ...context(), identity: { kind: "terminal_launch", sessionId: "s", incarnationId: "i", launchId: "l" } }, policy, "propose")).toBe("ask");
    for (const permissionMode of ["supervised", "auto", "auto_accept_edits"] as const)
      expect(routineActionPolicy(context(), { ...policy, permissionMode }, "control")).toBe("ask");
    expect(routineActionPolicy(context(), { ...policy, originCeiling: "exact" }, "control")).toBe("ask");
  });
  it("owner cards cannot override plan/review/shared/org/read ceilings or dead sources", () => {
    for (const patch of [{ interactionMode: "plan" }, { interactionMode: "review" }, { scope: "shared" }, { scope: "org" },
      { originCeiling: "read" }, { live: false }, { permissionMode: "unsupported" }])
      expect(routineActionPolicy(context(), { ...policy, ...patch } as typeof policy, "propose")).toBe("deny");
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

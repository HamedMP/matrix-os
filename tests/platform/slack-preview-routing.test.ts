import { describe, expect, it, vi } from "vitest";
import { createSlackMachineResolver, loadSlackDevAcceptance, loadSlackPreviewHandle, isSlackMachineAvailable } from "../../packages/platform/src/slack/home-resolver.js";

const id = "a1234567-1234-4123-8123-123456789abc";
const machine = { machineId: id, handle: "pr-2079", runtimeSlot: "pr-2079",
  provisioningClass: "preview" as const, clerkUserId: "user_owner", status: "running",
  publicIPv4: "203.0.113.1", deletedAt: null };
const route = { kind: "project", organizationId: "org_test", runtimeId: `vps:${id}`, ownerId: machine.clerkUserId };
function setup(previewHandle?: string) {
  const findPersonalMachine = vi.fn().mockResolvedValue(machine);
  const findMachineById = vi.fn().mockResolvedValue(machine);
  const findDirectoryRoute = vi.fn().mockResolvedValue(route);
  const resolve = createSlackMachineResolver({ previewHandle, findPersonalMachine, findMachineById, findDirectoryRoute });
  return { resolve, findPersonalMachine, findMachineById, findDirectoryRoute };
}

describe("Slack preview routing", () => {
  it("requires an explicit preview slot and rejects production overrides", () => {
    expect(loadSlackPreviewHandle({})).toBeUndefined();
    expect(loadSlackPreviewHandle({ PLATFORM_PREVIEW: "true", SLACK_PREVIEW_RUNTIME_HANDLE: "pr-2079" })).toBe("pr-2079");
    for (const env of [
      { PLATFORM_PREVIEW: "true" }, { SLACK_PREVIEW_RUNTIME_HANDLE: "pr-2079" },
      { PLATFORM_PREVIEW: "true", SLACK_PREVIEW_RUNTIME_HANDLE: "primary" },
      { PLATFORM_PREVIEW: "true", SLACK_PREVIEW_RUNTIME_HANDLE: "pr-0" },
    ]) expect(() => loadSlackPreviewHandle(env)).toThrow();
  });
  it("uses the employee's exact preview slot without falling back to primary", async () => {
    const s = setup("pr-2079");
    expect(await s.resolve("user_owner")).toEqual(machine);
    expect(s.findPersonalMachine).toHaveBeenCalledWith("user_owner", "pr-2079");
    s.findPersonalMachine.mockResolvedValue(undefined);
    await expect(s.resolve("user_owner")).rejects.toThrow("Slack home unavailable");
    expect(s.findPersonalMachine).toHaveBeenCalledTimes(2);
  });
  it("keeps normal personal routing on its existing default", async () => {
    const s = setup();
    expect(await s.resolve("user_owner")).toEqual(machine);
    expect(s.findPersonalMachine).toHaveBeenCalledWith("user_owner", undefined);
  });
  it("resolves company work only through the matching organization Project", async () => {
    const s = setup("pr-2079");
    expect(await s.resolve("user_member", "scope", "org_test")).toEqual(machine);
    expect(s.findMachineById).toHaveBeenCalledWith(id);
    expect(s.findPersonalMachine).not.toHaveBeenCalled();
    for (const changed of [{ organizationId: "org_other" }, { kind: "file" }, { runtimeId: "vps:not-a-uuid" }, { ownerId: "user_other" }]) {
      s.findDirectoryRoute.mockResolvedValue({ ...route, ...changed });
      await expect(s.resolve("user_member", "scope", "org_test")).rejects.toThrow();
    }
  });
  it("refuses a different owner's private machine", async () => {
    await expect(setup("pr-2079").resolve("user_other")).rejects.toThrow();
  });
  it.each([
    undefined, { ...machine, handle: "pr-2080" }, { ...machine, runtimeSlot: "primary" },
    { ...machine, provisioningClass: "customer" }, { ...machine, status: "stopped" },
    { ...machine, publicIPv4: null }, { ...machine, deletedAt: "2026-10-01" },
  ])("rejects unavailable or non-target machines %j", async (candidate) => {
    expect(isSlackMachineAvailable(candidate, "pr-2079")).toBe(false);
    const s = setup("pr-2079");
    s.findMachineById.mockResolvedValue(candidate);
    await expect(s.resolve("user_member", "scope", "org_test")).rejects.toThrow();
  });
});

describe("Slack Dev acceptance routing", () => {
  const target = { handle: "owner-dev", machineId: id, ownerId: "user_owner", organizationId: "org_test",
    teamId: "T123", channelId: "C123", ownerSlackId: "U123" };
  const env = { PLATFORM_PREVIEW: "true", SLACK_DEV_ACCEPTANCE: JSON.stringify(target), SLACK_DEV_BRIDGE_TOKEN: "a".repeat(64) };
  const devMachine = { ...machine, handle: target.handle, provisioningClass: "customer", runtimeSlot: "dev" };

  it("requires complete isolated Dev configuration and rejects coexistence with Preview", () => {
    expect(loadSlackDevAcceptance({})).toBeUndefined();
    expect(loadSlackDevAcceptance(env)).toMatchObject({ target });
    for (const override of [
      { PLATFORM_PREVIEW: undefined }, { SLACK_DEV_BRIDGE_TOKEN: undefined },
      { SLACK_PREVIEW_RUNTIME_HANDLE: "pr-2079" }, { SLACK_PREVIEW_THREAD_CONTEXT_GRANT: "{}" },
      { SLACK_PREVIEW_MENTION_SUMMARY_RULE: "{}" },
      { SLACK_DEV_ACCEPTANCE: JSON.stringify({ ...target, channelId: "D123" }) },
      { SLACK_DEV_ACCEPTANCE: JSON.stringify({ ...target, handle: "owner" }) },
    ]) expect(() => loadSlackDevAcceptance({ ...env, ...override })).toThrow();
  });

  it("resolves only the exact owner and registered Dev machine without a fallback lookup", async () => {
    const findMachineById = vi.fn().mockResolvedValue(devMachine);
    const findDirectoryRoute = vi.fn();
    const findPersonalMachine = vi.fn().mockResolvedValue(machine);
    const resolve = createSlackMachineResolver({ devAcceptance: target, findMachineById, findDirectoryRoute, findPersonalMachine });
    await expect(resolve(target.ownerId)).resolves.toEqual(devMachine);
    expect(findMachineById).toHaveBeenCalledWith(id);
    await expect(resolve("user_other")).rejects.toThrow();
    await expect(resolve(target.ownerId, "project", target.organizationId)).rejects.toThrow();
    await expect(resolve(target.ownerId, undefined, "org_other")).rejects.toThrow();
    for (const mutation of [{ runtimeSlot: "primary" }, { provisioningClass: "preview" }, { handle: "other-dev" },
      { clerkUserId: "user_other" }, { machineId: "b1234567-1234-4123-8123-123456789abc" }, { status: "stopped" }]) {
      findMachineById.mockResolvedValueOnce({ ...devMachine, ...mutation });
      await expect(resolve(target.ownerId)).rejects.toThrow();
    }
    expect(findPersonalMachine).not.toHaveBeenCalled();
    expect(findDirectoryRoute).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { ownerResourceReauthorizationRequest, createResourceReauthorizationCommands } from "../../packages/sync-client/src/cli/commands/collaboration-resource-reauthorization.js";
const runtime = "vps:11111111-1111-4111-8111-111111111111", org = "org_cli_reauthorize";
const scope = "10000000-0000-4000-8000-000000000001", resource = "20000000-0000-4000-8000-000000000001";
const identity = "b".repeat(64);
const args = { runtime, organization: org, scope, resource, kind: "file", project: "project_existing", revision: "7", identity, "confirm-current-object": true };
const inspection = { scopeId: scope, organizationId: org, resourceId: resource, kind: "file", path: "note", projectId: "project_existing", expectedRevision: "7", currentIncarnation: identity };
const confirmed = { scopeId: scope, entry: { id: resource, kind: "file", path: "note", incarnation: identity, revision: "8" } };
describe("explicit owner resource recovery CLI", () => {
  it("inspects an existing resource without generating a confirmation", async () => {
    const requestOwnerResourceReauthorization = vi.fn(async () => inspection);
    expect(await ownerResourceReauthorizationRequest("inspect", args, { requestOwnerResourceReauthorization })).toEqual(inspection);
    expect(requestOwnerResourceReauthorization).toHaveBeenCalledExactlyOnceWith({ runtimeId: runtime, resourceId: resource, action: "inspect",
      body: { scopeId: scope, organizationId: org, kind: "file" } });
  });
  it("requires an explicit revision, exact identity and confirmation before any owner request", async () => {
    for (const change of [{ "confirm-current-object": false }, { "confirm-current-object": undefined }, { revision: undefined }, { identity: undefined },
      { identity: "legacy" }, { revision: "9007199254740992" }, { resource: "new" }, { kind: "app" }]) {
      const requestOwnerResourceReauthorization = vi.fn();
      await expect(ownerResourceReauthorizationRequest("confirm", { ...args, ...change }, { requestOwnerResourceReauthorization })).rejects.toThrow();
      expect(requestOwnerResourceReauthorization).not.toHaveBeenCalled();
    }
  });
  it("confirms only the owner-supplied current object with its exact namespace and revision", async () => {
    const requestOwnerResourceReauthorization = vi.fn(async () => confirmed);
    expect(await ownerResourceReauthorizationRequest("confirm", args, { requestOwnerResourceReauthorization })).toEqual(confirmed);
    expect(requestOwnerResourceReauthorization).toHaveBeenCalledExactlyOnceWith({ runtimeId: runtime, resourceId: resource, action: "confirm",
      body: { scopeId: scope, organizationId: org, kind: "file", projectId: "project_existing", expectedRevision: "7", currentIncarnation: identity, confirmCurrentObject: true } });
  });
  it("registers separate inspect and confirm commands using the existing auth/result wrapper", async () => {
    const requestOwnerResourceReauthorization = vi.fn(async () => inspection);
    const run = vi.fn(async (values, operation) => operation("https://app.matrix-os.com", "owner-token"));
    const transport = vi.fn(() => ({ requestOwnerResourceReauthorization }));
    const commands = createResourceReauthorizationCommands({ commonArgs: {}, run, transport });
    await commands["resource-inspect"].run!({ args } as never);
    expect(run).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledExactlyOnceWith("https://app.matrix-os.com", "owner-token");
    expect(commands["resource-reauthorize"].args?.["confirm-current-object"]).toMatchObject({ type: "boolean", default: false });
  });  it("rejects mismatched resource/scope/kind or confirmed identity in an otherwise valid response", async () => {
    for (const response of [{ ...inspection, resourceId: scope }, { ...inspection, scopeId: resource }, { ...inspection, kind: "folder" }]) {
      await expect(ownerResourceReauthorizationRequest("inspect", args, { requestOwnerResourceReauthorization: vi.fn(async () => response) })).rejects.toThrow();
    }
    for (const response of [{ ...confirmed, entry: { ...confirmed.entry, id: scope } },
      { ...confirmed, entry: { ...confirmed.entry, incarnation: "c".repeat(64) } }]) {
      await expect(ownerResourceReauthorizationRequest("confirm", args, { requestOwnerResourceReauthorization: vi.fn(async () => response) })).rejects.toThrow();
    }
  });

});

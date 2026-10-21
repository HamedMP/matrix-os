/** Explicit two-step owner recovery; inspection never turns itself into approval. */
import {
  CollaborationCatalogIdSchema, CollaborationRuntimeIdSchema,
  CollaborationOwnerResourceReauthorizationInspectRequestSchema,
  CollaborationOwnerResourceReauthorizationConfirmRequestSchema,
  CollaborationOwnerResourceReauthorizationInspectionResponseSchema,
  CollaborationOwnerResourceReauthorizationResponseSchema,
} from "@matrix-os/contracts";
import { defineCommand, type ArgsDef } from "citty";
import type { CliCollaborationTransport } from "../collaboration-direct-transport.js";

type Transport = Pick<CliCollaborationTransport, "requestOwnerResourceReauthorization">;
export async function ownerResourceReauthorizationRequest(action: "inspect" | "confirm", args: Record<string, unknown>, transport: Transport) {
  const runtimeId = CollaborationRuntimeIdSchema.parse(args.runtime);
  const resourceId = CollaborationCatalogIdSchema.parse(args.resource);
  const scope = { scopeId: args.scope, organizationId: args.organization, kind: args.kind };
  const body = action === "inspect" ? CollaborationOwnerResourceReauthorizationInspectRequestSchema.parse(scope)
    : CollaborationOwnerResourceReauthorizationConfirmRequestSchema.parse({ ...scope, projectId: args.project ?? null,
      expectedRevision: args.revision, currentIncarnation: args.identity, confirmCurrentObject: args["confirm-current-object"] });
  const result = await transport.requestOwnerResourceReauthorization({ runtimeId, resourceId, action, body });
  if (action === "inspect") {
    const inspected = CollaborationOwnerResourceReauthorizationInspectionResponseSchema.parse(result);
    if (inspected.scopeId !== body.scopeId || inspected.resourceId !== resourceId || inspected.organizationId !== body.organizationId
      || inspected.kind !== body.kind) throw new Error("Collaboration request failed");
    return inspected;
  }
  const confirmed = CollaborationOwnerResourceReauthorizationResponseSchema.parse(result);
  if (confirmed.scopeId !== body.scopeId || confirmed.entry.id !== resourceId || confirmed.entry.kind !== body.kind
    || confirmed.entry.incarnation !== CollaborationOwnerResourceReauthorizationConfirmRequestSchema.parse(body).currentIncarnation) {
    throw new Error("Collaboration request failed");
  }
  return confirmed;
}

export function createResourceReauthorizationCommands(deps: {
  commonArgs: ArgsDef;
  run(args: Record<string, unknown>, operation: (platformUrl: string, token: string) => Promise<unknown>): Promise<unknown>;
  transport(platformUrl: string, token: string): Transport;
}) {
  const resourceArgs = { ...deps.commonArgs, runtime: { type: "string", required: true }, organization: { type: "string", required: true },
    scope: { type: "string", required: true }, resource: { type: "string", required: true }, kind: { type: "string", required: true } } as const;
  return {
    "resource-inspect": defineCommand({
      meta: { name: "resource-inspect", description: "Inspect the current object of an existing owner resource without changing its share" },
      args: resourceArgs,
      run: async ({ args }) => { await deps.run(args, (platform, token) => ownerResourceReauthorizationRequest("inspect", args, deps.transport(platform, token))); },
    }),
    "resource-reauthorize": defineCommand({
      meta: { name: "resource-reauthorize", description: "Explicitly authorize the inspected current object for an existing resource share" },
      args: { ...resourceArgs, project: { type: "string", required: false }, revision: { type: "string", required: true },
        identity: { type: "string", required: true }, "confirm-current-object": { type: "boolean", default: false } },
      run: async ({ args }) => { await deps.run(args, (platform, token) => ownerResourceReauthorizationRequest("confirm", args, deps.transport(platform, token))); },
    }),
  };
}

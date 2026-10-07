import {
  CollaborationMemberSchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod/v4";
import { ChatCollaboratorsDialog, type CollaborationApi } from "./ChatCollaboratorsDialog.js";

const MembersSchema = z.object({ members: z.array(CollaborationMemberSchema).max(8) }).strict();
type LegacyKind = Extract<CollaborationScope["kind"], "chat" | "terminal" | "file" | "folder" | "app">;
type LegacyState = {
  scope: CollaborationScope;
  members: z.infer<typeof CollaborationMemberSchema>[];
};

/**
 * Discovers an already-existing standalone live share and exposes only its
 * transition management surface. This component never calls scope creation.
 */
export function LegacyLiveAccessButton({
  api,
  runtimeId,
  organizationId,
  kind,
  resourceId,
  resourceLabel,
  containerClassName,
}: {
  api: CollaborationApi;
  runtimeId: string | null;
  organizationId: string | null;
  kind: LegacyKind;
  resourceId: string;
  resourceLabel: string;
  containerClassName?: string;
}) {
  const [legacy, setLegacy] = useState<LegacyState | null>(null);
  const [open, setOpen] = useState(false);

  const read = useCallback(async (scopeId: string): Promise<LegacyState> => {
    const [scopeValue, membersValue] = await Promise.all([
      api.get(`/api/collaboration/scopes/${encodeURIComponent(scopeId)}`),
      api.get(`/api/collaboration/scopes/${encodeURIComponent(scopeId)}/members`),
    ]);
    const scope = CollaborationScopeSchema.parse(scopeValue);
    if (scope.kind !== kind || scope.resourceId !== resourceId || scope.organizationId !== organizationId
      || scope.membershipMode !== "direct") {
      throw new Error("Legacy scope mismatch");
    }
    return { scope, members: MembersSchema.parse(membersValue).members };
  }, [api, kind, organizationId, resourceId]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- visibility depends on an owner-authorized preflight that proves an existing scope; the effect is bounded, cancellable, and never creates a share.
  useEffect(() => {
    let active = true;
    setLegacy(null);
    setOpen(false);
    if (!runtimeId || !organizationId || !resourceId) return () => { active = false; };
    void api.post(`/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes/preflight`, {
      kind,
      resourceId,
      organizationId,
    }).then((value) => {
      const preflight = CollaborationScopePreflightResponseSchema.parse(value);
      return preflight.existingScopeId ? read(preflight.existingScopeId) : null;
    }).then((next) => {
      if (active && next) setLegacy(next);
    }).catch((failure: unknown) => {
      console.warn("[legacy-collaboration] discovery failed", failure instanceof Error ? failure.name : "UnknownError");
    });
    return () => { active = false; };
  }, [api, kind, organizationId, read, resourceId, runtimeId]);

  if (!legacy) return null;
  return <>
    <span className={containerClassName ?? "inline-flex"}>
      <button type="button" aria-label={`Manage legacy ${resourceLabel} access`} aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="rounded-lg border px-3 py-1.5 text-xs hover:bg-[var(--bg-hover)]">
        Manage live access
      </button>
    </span>
    {open ? <ChatCollaboratorsDialog api={api} scope={legacy.scope} members={legacy.members}
      allowNewGrants={false}
      onRefresh={async () => {
        const next = await read(legacy.scope.id);
        setLegacy(next);
        return next;
      }}
      onClose={() => setOpen(false)} /> : null}
  </>;
}

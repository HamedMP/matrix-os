import {
  CollaborationAppInstanceIdSchema,
  CollaborationOwnerCatalogLookupResponseSchema,
  isSafeCollaborationRelativePath,
} from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { LegacyLiveAccessButton } from "./LegacyLiveAccessButton.js";

function identifies(kind: "file" | "folder" | "app", value: string): boolean {
  return kind === "app"
    ? CollaborationAppInstanceIdSchema.safeParse(value).success
    : isSafeCollaborationRelativePath(value);
}

/** Resolves an owner resource only so an already-existing legacy share can be managed. */
export function LegacyResourceAccessButton({ api, runtimeId, organizationId, kind, path, containerClassName }: {
  api: CollaborationApi;
  runtimeId: string | null;
  organizationId: string | null;
  kind: "file" | "folder" | "app";
  path: string;
  containerClassName?: string;
}) {
  const [resourceId, setResourceId] = useState<string | null>(null);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- catalog resolution is a bounded owner lookup used only to discover existing legacy access; it cannot create a share.
  useEffect(() => {
    let active = true;
    setResourceId(null);
    if (!runtimeId || !organizationId || !identifies(kind, path)) return () => { active = false; };
    const runtime = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}`;
    void api.post(`${runtime}/catalog/lookup`, { kind, path, organizationId }).then((value) => {
      const resolved = CollaborationOwnerCatalogLookupResponseSchema.parse(value).entry;
      if (!resolved) return;
      if (resolved.kind !== kind || resolved.path !== path) throw new Error("Catalog mismatch");
      if (active) setResourceId(resolved.id);
    }).catch((failure: unknown) => {
      console.warn("[legacy-collaboration] resource lookup failed", failure instanceof Error ? failure.name : "UnknownError");
    });
    return () => { active = false; };
  }, [api, kind, organizationId, path, runtimeId]);

  return resourceId ? <LegacyLiveAccessButton api={api} runtimeId={runtimeId} organizationId={organizationId}
    kind={kind} resourceId={resourceId} resourceLabel={kind === "app" ? "app" : kind}
    containerClassName={containerClassName} /> : null;
}

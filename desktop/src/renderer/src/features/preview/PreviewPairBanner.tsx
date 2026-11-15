import React, { useEffect, useState } from "react";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useDesktopOrganizations } from "../collaboration/useDesktopOrganizations";
import type { DesktopPreviewSummary } from "../../../../shared/preview-pair";
import { StatusBanner } from "./StatusBanner";
function BoundPreviewBanner({ preview }: { preview: DesktopPreviewSummary }) {
  const status = useConnection(state => state.status), handle = useConnection(state => state.handle);
  const organizationId = useConnection(state => state.organizationId), select = useConnection(state => state.selectOrganization);
  const listing = useDesktopOrganizations();
  const organization = listing.state === "loaded" && listing.complete
    ? listing.organizations.find(item => item.organizationId === preview.organizationId) : undefined;
  useEffect(() => {
    if (status === "signed-in" && organization && organizationId !== organization.organizationId) select(organization.organizationId);
  }, [status, organization, organizationId, select]);
  const title = `Collaboration preview · ${preview.role === "owner" ? "Owner" : "Member"} · PR #${preview.pr}`;
  const identity = `${preview.sourceSha.slice(0, 12)} · ${status === "signed-in" ? handle : preview.handle}`;
  const account = status === "signed-in" ? organization?.name ?? "Organization unavailable" : `Sign in with the ${preview.role} test account`;
  return <StatusBanner fullText={`${title} · ${identity} · ${account}`}>
    <strong>{title}</strong>
    <span> · {identity}</span>
    <span> · {account}</span>
  </StatusBanner>;
}
export function PreviewPairBanner() {
  const [preview, setPreview] = useState<DesktopPreviewSummary | null>(null);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- immutable, bounded main-process presentation metadata is loaded once at application boot.
  useEffect(() => {
    let active = true;
    void invoke("app:get-preview", {}).then(value => { if (active) setPreview(value); })
      .catch((error: unknown) => console.warn("[preview-pair] presentation unavailable", error instanceof Error ? error.name : "UnknownError"));
    return () => { active = false; };
  }, []);
  return preview ? <BoundPreviewBanner preview={preview} /> : null;
}

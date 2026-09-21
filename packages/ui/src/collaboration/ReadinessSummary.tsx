import type { CollaborationReadiness } from "@matrix-os/contracts";

const sourceLabels = {
  matrix_included: "Matrix AI included",
  owner_account: "Owner account",
  owner_api_key: "Owner API key",
  matrix_addon: "Matrix AI add-on",
} as const;
const setupLabels = {
  ai_source: "Owner AI source needs setup",
  git_identity: "Owner Git identity needs setup",
  forge_credential: "Owner GitHub access needs setup",
} as const;

/** Renders only the authority's bounded readiness projection; never infers a provider or payer. */
export function ReadinessSummary({ readiness }: { readiness: CollaborationReadiness }) {
  const execution = readiness.resourceKind === "project" || readiness.resourceKind === "chat";
  const gitIdentity = readiness.items.find((item) => item.item === "git_identity");
  const roots = readiness.items.find((item) => item.item === "chat_root_inventory");
  const rooted = readiness.resourceKind === "project" || (roots?.item === "chat_root_inventory" && (roots.chatRootCount ?? 0) > 0);
  return <section aria-label="Ready to work" className="rounded-xl border p-4 text-sm">
    <h3 className="font-medium">Ready to work</h3>
    {readiness.state === "host_offline" ? <p className="mt-2">The owner computer is offline.</p> : null}
    {readiness.state === "unsupported" ? <p className="mt-2">This resource cannot be shared yet.</p> : null}
    {readiness.missingOwnerSetup.length > 0 ? <ul className="mt-2 space-y-1">
      {readiness.missingOwnerSetup.map((item) => <li key={item}>{setupLabels[item]}</li>)}
    </ul> : null}
    {execution ? <div className="mt-2 space-y-1">
      <p>AI source: {readiness.sourceKind ? sourceLabels[readiness.sourceKind] : "Unavailable"}</p>
      <p>{readiness.effectiveSubmitMode === "members" ? "Contributors may submit AI requests" : "Owner approves AI requests"}</p>
      {rooted && gitIdentity?.item === "git_identity" && gitIdentity.status === "ready"
        ? <p>Git identity: {gitIdentity.identityLabel ?? "Owner Git identity ready"}</p> : null}
      {rooted && roots?.item === "chat_root_inventory" ? <p>{roots.chatRootCount === undefined
        ? "Chat roots unavailable"
        : `${roots.chatRootCount} Chat roots${roots.dirtyRootCount ? ` · ${roots.dirtyRootCount} with uncommitted changes` : ""}`}</p> : null}
    </div> : <p className="mt-2">{readiness.state === "ready" ? "Ready to share." : "Readiness unavailable."}</p>}
  </section>;
}

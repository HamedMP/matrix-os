import type { CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import { ChatContextReceipt, hasChatMentionParts } from "@matrix-os/ui";

/** Queue edits retain admitted references and snapshots; never preview live sources here. */
export function QueuedTurnEditContext({ turn }: { turn: CanonicalChatQueuedTurn }) {
  const references = turn.parts.flatMap((part) => {
    if (part.type === "resource_reference") return [{ key: `${part.type}:${part.resource.kind}:${part.resource.id}`, label: part.resource.label }];
    if (part.type === "invocation_reference") return [{ key: `${part.type}:${part.invocation.descriptorId}`, label: part.invocation.invocation }];
    if (part.type === "attachment_reference") return [{ key: `${part.type}:${part.attachmentId}`, label: part.label }];
    return [];
  });
  const access = turn.permissionMode === "full_access" ? "Full access"
    : turn.permissionMode === "supervised" ? "Supervised"
      : turn.permissionMode === "read_only" ? "Read only" : "Recorded access mode unavailable";
  return <section aria-label="Queued request context" className="mx-3 my-2 min-w-0 rounded-lg border px-3 py-2 text-xs"
    style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}>
    <p>Saving edits keeps the queued references, model and access setting.</p>
    <p className="mt-1">Access: <strong>{access}</strong></p>
    <p className="mt-1 break-words">Model: {turn.selection.model}</p>
    {references.length ? <ul className="mt-2 flex min-w-0 flex-wrap gap-2" aria-label="Fixed references">
      {references.map((reference) => <li key={reference.key} className="max-w-full truncate rounded border px-2 py-1" title={reference.label}>{reference.label}</li>)}
    </ul> : null}
    {turn.context?.agent ? <p className="mt-2">Agent revision {turn.context.agent.revision}</p> : null}
    <ChatContextReceipt context={turn.context} />
    {!turn.context && hasChatMentionParts(turn.parts) ? <p className="mt-2">Saved context details are unavailable.</p> : null}
  </section>;
}

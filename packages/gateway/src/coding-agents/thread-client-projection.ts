import { projectPlaintextToolPreview } from "../chat/plaintext-tool-preview.js";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";

/** Native completion evidence is internal to canonical Chat. Old thread clients
 * use a strict event schema, and no general thread view may reveal commands. */
export function projectThreadEventForClient(event: AgentThreadEvent): AgentThreadEvent {
  if (event.type === "tool.started") {
    const { protectedPreview: _protectedPreview, ...coarse } = event;
    return projectPlaintextToolPreview(coarse);
  }
  if (event.type === "tool.completed") {
    const { protectedPreview: _protectedPreview, preview: _preview, previewKind: _kind, detail: _detail, ...coarse } = event;
    return coarse;
  }
  return event;
}

export function projectThreadSnapshotForClient(snapshot: AgentThreadSnapshot): AgentThreadSnapshot {
  return { ...snapshot, events: { ...snapshot.events, items: snapshot.events.items.map(projectThreadEventForClient) } };
}

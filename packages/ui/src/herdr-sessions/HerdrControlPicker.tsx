import { useEffect, useState } from "react";
import type { CanonicalChatMessagePart, CanonicalChatResourceReference } from "@matrix-os/contracts";
import { Button } from "../Button.js";
import { herdrSessionRefKey, loadHerdrSessions, type HerdrSession, type HerdrSessionsRequest } from "./herdr-sessions-client.js";

export const herdrControlCommand = { kind: "command", descriptorId: "herdr-terminal-control", invocation: "/herdr-terminal-control" } as const;

export function herdrControlParts(target: CanonicalChatResourceReference): CanonicalChatMessagePart[] {
  return [{ type: "invocation_reference", invocation: herdrControlCommand }, { type: "resource_reference", resource: target }];
}

/** Only an explicit choice produces a target. Names and search suggestions are display data. */
export function HerdrControlPicker({ request, onSelect, onCancel }: {
  request: HerdrSessionsRequest;
  onSelect(target: CanonicalChatResourceReference): void;
  onCancel(): void;
}) {
  const [sessions, setSessions] = useState<HerdrSession[] | null>(null);
  useEffect(() => {
    let current = true;
    void loadHerdrSessions((path, init) => request(`${path}?view=chat-control`, init)).then(list => {
      if (current) setSessions(list.available ? list.sessions.filter(session => session.revision) : []);
    }).catch((error: unknown) => {
      console.warn("[herdr] Chat terminal list unavailable", error instanceof Error ? error.name : "UnknownError");
      if (current) setSessions([]);
    });
    return () => { current = false; };
  }, [request]);
  return <section aria-label="Choose a Herdr terminal" className="rounded-lg border p-3 text-sm">
    <p>Choose a terminal running in this worktree on the selected computer. For this run, Chat can read its output, send text, and interrupt it.</p>
    {sessions === null ? <p role="status">Loading terminals…</p> : !sessions.length ? <p role="status">No eligible Herdr terminals.</p> : (
      <div className="my-1 flex max-h-44 flex-wrap gap-1 overflow-y-auto">{sessions.map(session => (
        <Button key={session.tabId} type="button" variant="secondary" size="sm" onClick={() => onSelect({
          kind: "terminal_session", id: herdrSessionRefKey(session), label: session.title, revision: session.revision,
        })}>{session.title} ({session.id})</Button>
      ))}</div>
    )}
    <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
  </section>;
}

import { useEffect, useState } from "react";
import { HerdrSessionIdSchema } from "@matrix-os/contracts/herdr-terminals";
import type { CanonicalChatMessagePart, CanonicalChatResourceReference } from "@matrix-os/contracts";
import { Button } from "../Button.js";
import { herdrSessionRefKey, loadHerdrSessions, type HerdrSession, type HerdrSessionsRequest } from "./herdr-sessions-client.js";

export const herdrControlCommand = { kind: "command", descriptorId: "herdr-terminal-control", invocation: "/herdr-terminal-control" } as const;

export function herdrControlParts(target: CanonicalChatResourceReference): CanonicalChatMessagePart[] {
  return [{ type: "invocation_reference", invocation: herdrControlCommand }, { type: "resource_reference", resource: target }];
}

/** Only an explicit choice produces a target. Names and search suggestions are display data. */
export function HerdrControlPicker({ request, onSelect, onCancel, requestedTarget, computerName }: {
  request: HerdrSessionsRequest;
  requestedTarget?: string;
  computerName?: string;
  onSelect(target: CanonicalChatResourceReference, terminalId: string): void;
  onCancel(): void;
}) {
  const [inventory, setInventory] = useState<{ request: HerdrSessionsRequest; sessions: HerdrSession[] } | null>(null);
  const sessions = inventory?.request === request ? inventory.sessions : null;
  useEffect(() => {
    let current = true;
    const load = () => void loadHerdrSessions((path, init) => request(`${path}?view=chat-control`, init)).then(list => {
      if (current) setInventory({ request, sessions: list.available ? list.sessions.filter(session => session.revision) : [] });
    }).catch((error: unknown) => {
      console.warn("[herdr] Chat terminal list unavailable", error instanceof Error ? error.name : "UnknownError");
      if (current) setInventory({ request, sessions: [] });
    });
    const timer = requestedTarget ? setTimeout(load, 180) : undefined;
    if (!requestedTarget) load();
    return () => { current = false; clearTimeout(timer); };
  }, [request, requestedTarget]);
  // A numeric id is an address; a title can match several separate live processes.
  const byId = requestedTarget && HerdrSessionIdSchema.safeParse(requestedTarget).success;
  const matches = requestedTarget ? sessions?.filter(session => byId ? session.id === requestedTarget
    : session.title.toLowerCase() === requestedTarget.toLowerCase()) : sessions;
  const visible = requestedTarget ? matches?.slice(0, 5) : matches;
  const duplicateId = byId && matches && matches.length > 1;
  let options;
  if (!visible) {
    options = <p role="status">Loading terminals…</p>;
  } else if (!visible.length || duplicateId) {
    options = <p role="status">{requestedTarget
      ? `gateway/${requestedTarget} is unavailable. Ask Chat to list terminals again.` : "No eligible Herdr terminals."}</p>;
  } else {
    options = <>
      {requestedTarget && matches && matches.length > 1 && <p role="status">
        {matches.length} terminals match. {matches.length > visible.length ? "Showing the first five. Ask Chat to narrow the list." : "Choose an address."}
      </p>}
      <div className="my-1 flex max-h-44 flex-wrap gap-1 overflow-y-auto">{visible.map(session => (
        <Button key={session.tabId} type="button" variant="secondary" size="sm" onClick={() => onSelect({
          kind: "terminal_session", id: herdrSessionRefKey(session), label: session.title, revision: session.revision,
        }, session.id)}>{requestedTarget ? `Use ${session.title} (gateway/${session.id})` : `${session.title} (${session.id})`}</Button>
      ))}</div>
    </>;
  }
  return <section aria-label="Choose a Herdr terminal" className="rounded-lg border p-3 text-sm">
    <p>{requestedTarget ? `Allow this message to read, send input to, and interrupt this terminal on ${computerName || "the selected computer"}?`
      : "Choose a terminal running in this worktree on the selected computer. For this run, Chat can read its output, send text, and interrupt it."}</p>
    {options}
    {!requestedTarget && <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
  </section>;
}

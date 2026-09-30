import { groupBotAuthority, botServiceLabel, botConnectionStateLabel, botAccessLabel, type BotAuthorityView, type BotMemoryMutationRequest } from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import { RememberedItemPart } from "./RememberedItemPart.js";
import { BotSettingsEmptyState } from "./BotSettingsEmptyState.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";

export function BotAuthorityPanel({ view, onRevoke, onMemory, onChanged, onConfirmedChange, actionsAvailable = true }: {
  view: BotAuthorityView;
  actionsAvailable?: boolean;
  onRevoke: (grantId: string) => Promise<unknown>;
  onMemory: (itemId: string, action: "confirm" | "forget", input: BotMemoryMutationRequest) => Promise<unknown>;
  onChanged?: () => void;
  onConfirmedChange?: (apply: (value: BotAuthorityView) => BotAuthorityView) => void;
}) {
  const [section, setSection] = useState<"connections" | "memory" | "routines">("connections");
  const [current, setCurrent] = useState(view);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { setCurrent(view); }, [view]);
  const groups = groupBotAuthority(current);
  const change = async (key: string, action: () => Promise<unknown>, apply: (value: BotAuthorityView) => BotAuthorityView) => {
    if (pending || !actionsAvailable) return;
    setPending(key);
    setError("");
    try {
      await action();
      setCurrent((value) => apply(value));
      onConfirmedChange?.(apply);
      onChanged?.();
    } catch (failure: unknown) {
      console.warn("[chat-agents] Bot authority change failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError("Could not save this change. Try again.");
    } finally {
      setPending(null);
    }
  };
  return <section aria-label="Bot settings sections" className="flex min-h-0 flex-1 flex-col">
    <nav aria-label="Bot settings sections" className="matrix-bot-settings-nav">
      {(["connections", "memory", "routines"] as const).map((key) => <button key={key} type="button"
        aria-pressed={section === key} className="matrix-bot-settings-tab" onClick={() => setSection(key)}>
        {key.charAt(0).toUpperCase() + key.slice(1)} <span>{key === "connections" ? groups.length : key === "memory" ? current.memory.items.length : current.routines.length}</span>
      </button>)}
    </nav>
    <div className="matrix-bot-settings-body">
    {error ? <p role="alert" className="mb-4 text-xs">{error}</p> : null}
    {section === "connections" ? <div className="grid gap-4">
      <div><h3 className="text-sm font-semibold">Connected accounts</h3><p className="mt-1 text-xs leading-relaxed" style={chatAgentMutedStyle}>Only the access you've allowed for this bot.</p></div>
      {groups.length ? groups.map((group) => <div key={group.service} className="matrix-bot-settings-card grid gap-3">
        <h4 className="text-sm font-medium">{botServiceLabel(group.service)}</h4>
        <p className="text-xs" style={chatAgentMutedStyle}>{botConnectionStateLabel(group.state)}</p>
        {group.grants.map((grant) => <div key={grant.grantId} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">{grant.accountLabel} · {botAccessLabel(grant.effects)}</span>
          <button type="button" aria-label={`Revoke ${grant.accountLabel}`} className={chatAgentButtonClass} disabled={!!pending || !actionsAvailable}
            onClick={() => { void change(grant.grantId, () => onRevoke(grant.grantId),
              (value) => {
                const grants = value.grants.filter((entry) => entry.grantId !== grant.grantId);
                return { ...value, grants, connections: value.connections.map((connection) => (
                  connection.service === grant.service && connection.state === "granted"
                    && !grants.some((entry) => entry.service === grant.service)
                    ? { ...connection, state: "connected_not_granted" as const } : connection
                )) };
              }); }}>Revoke</button>
        </div>)}
      </div>) : <BotSettingsEmptyState section="connections" />}
    </div> : null}
    {section === "memory" ? <div className="grid gap-4"><div><h3 className="text-sm font-semibold">What your bot remembers</h3><p className="mt-1 text-xs leading-relaxed" style={chatAgentMutedStyle}>Preferences and context saved for this bot. You can forget them anytime.</p></div>
      {current.memory.items.length ? current.memory.items.map((item) => <div key={item.itemId} className="matrix-bot-settings-card grid gap-3">
        <RememberedItemPart item={item} />
        <div className="flex flex-wrap gap-2">
          {!item.confirmed ? <button type="button" aria-label="Confirm memory" className={chatAgentButtonClass} disabled={!!pending || !actionsAvailable}
            onClick={() => { void change(item.itemId, () => onMemory(item.itemId, "confirm", { baseRevision: item.revision }),
              (value) => ({ ...value, memory: { ...value.memory, items: value.memory.items.map((entry) => entry.itemId === item.itemId
                ? { ...entry, confirmed: true, revision: entry.revision + 1 } : entry) } })); }}>Confirm</button> : null}
          <button type="button" aria-label="Forget memory" className={chatAgentButtonClass} disabled={!!pending || !actionsAvailable}
            onClick={() => { void change(item.itemId, () => onMemory(item.itemId, "forget", { baseRevision: item.revision }),
              (value) => ({ ...value, memory: { ...value.memory, items: value.memory.items.filter((entry) => entry.itemId !== item.itemId) } })); }}>Forget</button>
        </div>
      </div>) : <BotSettingsEmptyState section="memory" />}
    </div> : null}
    {section === "routines" ? <div className="grid gap-4"><div><h3 className="text-sm font-semibold">Routines</h3><p className="mt-1 text-xs leading-relaxed" style={chatAgentMutedStyle}>Scheduled work for this bot.</p></div>
      {current.routines.length ? current.routines.map((routine) => <div key={routine.routineId} className="matrix-bot-settings-card grid gap-2">
        <p className="text-sm font-medium">{routine.summary}</p>
        <p className="text-xs" style={chatAgentMutedStyle}>{routine.status === "active" ? "Active" : "Paused"}{routine.nextFireAt ? ` · Next: ${new Date(routine.nextFireAt).toLocaleString()}` : ""}</p>
      </div>) : <BotSettingsEmptyState section="routines" />}
    </div> : null}
    </div>
  </section>;
}

import { useState } from "react";
import type { BotRoutineClient } from "./routine-client.js";
import { useRoutineChatHistory } from "./use-routine-chat-history.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";

/** Saved occurrence records include failures that never admitted an Agent turn. */
export function RoutineChatHistory({api, chatId}: {api: BotRoutineClient; chatId: string}) {
  const [open, setOpen] = useState(false);
  const history = useRoutineChatHistory(api, chatId, open);
  return <details className="min-w-0 shrink-0 border-b px-3 py-2 text-sm" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer">Scheduled task history</summary>
    {open ? <section aria-label="Scheduled task history" className="mt-3 grid max-h-72 min-w-0 gap-3 overflow-auto">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={chatAgentButtonClass} aria-pressed={!history.archived} onClick={history.showCurrent}>Current tasks</button>
        <button type="button" className={chatAgentButtonClass} aria-pressed={history.archived} onClick={history.showArchived}>Archived tasks</button>
        <button type="button" className={chatAgentButtonClass} disabled={history.loading || history.detailLoading} onClick={history.refresh}>Refresh history</button>
      </div>
      {history.error ? <p role="alert">{history.error}</p> : null}
      {history.loading ? <p role="status">Loading scheduled tasks…</p> : null}
      {!history.loading && !history.items.length ? <p style={chatAgentMutedStyle}>No {history.archived ? "archived" : "current"} schedules for this Chat on this page.</p> : null}
      {history.items.map(row => <button key={row.routineId} type="button" className={`${chatAgentButtonClass} text-left`} aria-label={`History for ${row.proposal.name}`} onClick={() => history.select(row.routineId)}>{row.proposal.name}</button>)}
      {history.nextCursor ? <button type="button" className={chatAgentButtonClass} disabled={history.loading} onClick={history.nextPage}>Next history page</button> : null}
      {history.detailLoading ? <p role="status">Loading runs…</p> : null}
      {history.detail ? <section aria-label="Saved schedule runs" className="grid gap-2">
        <h3 className="font-semibold">{history.detail.routine.proposal.name}</h3><p style={chatAgentMutedStyle}>Recent saved runs (up to 20).</p>
        {!history.detail.history.length ? <p>No runs yet.</p> : <ol className="grid gap-2">{history.detail.history.map(fire => <li key={fire.fireId} className="rounded-lg border p-3">
          <p>{new Date(fire.scheduledFor).toLocaleString()} · {fire.status} · {fire.attempts} attempt{fire.attempts === 1 ? "" : "s"}</p>
          {fire.failureCode ? <p>Execution did not complete. Review this task before retrying; uncertain work is not replayed automatically.</p> : null}
        </li>)}</ol>}
      </section> : null}
    </section> : null}
  </details>;
}

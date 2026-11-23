/**
 * Bulk drafts: paste a table (or receive sheet rows), write one instruction,
 * review one personalised draft per row, create drafts for the selected
 * rows, and, as a separate step, send them after ConfirmSend.
 */
import { useMemo, useState } from "react";
import { ConfirmSend, Dialog, Select, Spinner, TextField } from "../../../../_shared/office-ui";
import type { BulkDrafts } from "../../agent/bulk";
import { parseTable, recipientColumn, tableFromRows, type BulkTable } from "../../agent/bulk-rows";
import { bulkCounts, emptyBulkState, type BulkState, type SendRequest } from "../../agent/bulk-state";
import type { MailAgent } from "../../agent/controller";
import { agentErrorMessage } from "../../agent/errors";
import { MAX_BULK_ROWS } from "../../agent/limits";
import type { MailStore } from "../../model";
import { BulkRowList } from "./BulkRowList";
import { useExternal } from "./use-external";

export interface BulkDraftsDialogProps {
  open: boolean;
  onClose: () => void;
  agent: MailAgent;
  store: MailStore;
  /** A sheet range handed in as rows (first row is the header). */
  initialRows?: readonly (readonly unknown[])[] | null;
}

const EMPTY = emptyBulkState();

export function BulkDraftsDialog({ open, onClose, agent, store, initialRows }: BulkDraftsDialogProps) {
  const accounts = store.getSnapshot().accounts.map((entry) => entry.account);
  const [pasted, setPasted] = useState("");
  const [instruction, setInstruction] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [column, setColumn] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkDrafts | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SendRequest | null>(null);
  const state = useExternal(bulk, (b) => (b as BulkDrafts).getState(), EMPTY) as BulkState;

  const table: BulkTable = useMemo(() => (initialRows?.length ? tableFromRows(initialRows) : parseTable(pasted)), [initialRows, pasted]);
  const detected = useMemo(() => recipientColumn(table), [table]);
  const chosenColumn = column && table.columns.includes(column) ? column : detected;
  const counts = bulkCounts(state);
  const working = state.phase !== "idle" && state.phase !== "review";

  async function start() {
    setError(null);
    if (!table.rows.length || !instruction.trim()) return;
    setStarting(true);
    try {
      const session = await agent.createBulk(accountId || undefined);
      session.load(table, instruction, chosenColumn);
      setBulk(session);
      await session.generate();
    } catch (cause: unknown) {
      setError(agentErrorMessage(cause, "ai_failed"));
    } finally {
      setStarting(false);
    }
  }

  async function create() {
    if (!bulk) return;
    setError(null);
    try {
      const result = await bulk.createDrafts();
      if (result.failed) setError(`${result.failed} ${result.failed === 1 ? "draft was" : "drafts were"} not saved. They are marked below.`);
    } catch (cause: unknown) {
      setError(agentErrorMessage(cause));
    }
  }

  const closeAll = () => {
    if (working && bulk) bulk.cancel();
    onClose();
  };

  const footer = !bulk ? (
    <>
      <button type="button" className="oui-button" onClick={closeAll}>Cancel</button>
      <button type="button" className="oui-button oui-button--primary" disabled={starting || !table.rows.length || !instruction.trim() || !chosenColumn} onClick={() => void start()}>
        {starting ? "Starting…" : `Write ${table.rows.length} ${table.rows.length === 1 ? "draft" : "drafts"}`}
      </button>
    </>
  ) : (
    <>
      <span className="mail-bulk__counts" aria-live="polite">
        {counts.selected} selected · {counts.created} saved · {counts.sent} sent · {counts.failed} failed
      </span>
      {state.phase === "generating" ? (
        <button type="button" className="oui-button" onClick={() => bulk.cancel()}>Stop</button>
      ) : (
        <>
          <button type="button" className="oui-button oui-button--ghost" disabled={working} onClick={() => bulk.setAllSelected(counts.selected === 0)}>
            {counts.selected === 0 ? "Select all" : "Select none"}
          </button>
          <button type="button" className="oui-button" disabled={working || !state.rows.some((r) => r.selected && (r.status === "ready" || r.status === "create_failed"))} onClick={() => void create()}>
            Create drafts
          </button>
          <button
            type="button"
            className="oui-button oui-button--primary"
            disabled={working || !state.rows.some((r) => r.selected && (r.status === "created" || r.status === "send_failed"))}
            onClick={() => setConfirm(bulk.requestSend())}
          >
            Send selected…
          </button>
        </>
      )}
    </>
  );

  return (
    <>
      <Dialog open={open && !confirm} onClose={closeAll} title="Bulk drafts" description="One personalised draft per row. Review them, save them as drafts, and send only the ones you choose." size="lg" footer={footer} dismissOnBackdrop={false}>
        {!bulk ? (
          <div className="mail-bulk__setup">
            {!initialRows?.length && (
              <TextField label="Rows" multiline rows={6} value={pasted} onChange={setPasted} placeholder={"Name\tEmail\tCity\nAda\tada@example.com\tLondon"} hint={`Paste a table with a header row, from a sheet or a CSV file. At most ${MAX_BULK_ROWS} rows.`} />
            )}
            <p className="mail-bulk__note">
              {table.rows.length} {table.rows.length === 1 ? "row" : "rows"}{table.columns.length ? ` · columns: ${table.columns.join(", ")}` : ""}
              {table.overLimit ? ` · only the first ${MAX_BULK_ROWS} rows are used` : ""}
            </p>
            {table.columns.length > 0 && (
              <Select label="Email column" value={chosenColumn ?? ""} onChange={(value) => setColumn(value || null)} options={[{ value: "", label: "Choose a column" }, ...table.columns.map((c) => ({ value: c, label: c }))]} error={chosenColumn ? null : "Choose the column with email addresses."} />
            )}
            {accounts.length > 1 && (
              <Select label="From" value={accountId} onChange={setAccountId} options={accounts.map((a) => ({ value: a.id, label: a.address }))} />
            )}
            <TextField label="Instruction" multiline rows={3} value={instruction} onChange={setInstruction} maxLength={2000} placeholder="Invite each person to the launch on 4 December and mention their city." />
          </div>
        ) : (
          <div className="mail-bulk__review">
            {state.phase === "generating" && <Spinner label={`Writing drafts (${counts.total - counts.working} of ${counts.total})`} />}
            <BulkRowList rows={state.rows} bulk={bulk} busy={working} />
          </div>
        )}
        {error && <p className="mail-bulk__error" role="alert">{error}</p>}
      </Dialog>
      <ConfirmSend
        open={Boolean(confirm)}
        recipients={confirm?.recipients ?? []}
        summary={confirm ? `${confirm.recipients.length} separate ${confirm.recipients.length === 1 ? "email" : "emails"}, one per recipient` : undefined}
        confirmLabel={confirm ? `Send ${confirm.recipients.length}` : "Send"}
        onCancel={() => {
          bulk?.cancelSend();
          setConfirm(null);
        }}
        onConfirm={async () => {
          if (!bulk || !confirm) return;
          const result = await bulk.confirmSend(confirm.token);
          setConfirm(null);
          if (result.failed) setError(`${result.failed} ${result.failed === 1 ? "email was" : "emails were"} not sent. They are marked below.`);
        }}
      />
    </>
  );
}

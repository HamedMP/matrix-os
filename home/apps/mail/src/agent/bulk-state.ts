/**
 * The bulk drafts state machine, as pure functions over plain data.
 *
 *   queued → generating → ready ⇄ (edit) → creating → created → sending → sent
 *                       ↘ failed         ↘ create_failed      ↘ send_failed
 *
 * Every row is independent: a failure marks only that row. Sending needs a
 * send request (a one-time token over exactly the selected, created rows);
 * any edit or selection change withdraws it.
 */
import type { BulkTable } from "./bulk-rows";
import { rowRecipient } from "./bulk-rows";
import { MAIL_AGENT_ERROR_MESSAGES, type MailAgentErrorCode } from "./errors";

export type BulkRowStatus =
  | "queued"
  | "generating"
  | "ready"
  | "failed"
  | "creating"
  | "created"
  | "create_failed"
  | "sending"
  | "sent"
  | "send_failed";

export interface BulkRow {
  index: number;
  values: Record<string, string>;
  /** Recipient taken from the row itself, never from the model. */
  to: string | null;
  status: BulkRowStatus;
  selected: boolean;
  subject: string;
  body: string;
  edited: boolean;
  /** The provider draft once created; later saves replace it. */
  providerDraftId: string | null;
  /** An allowlisted sentence, or null. */
  error: string | null;
}

export type BulkPhase = "idle" | "generating" | "review" | "creating" | "sending";

export interface SendRequest {
  token: string;
  rowIndexes: number[];
  recipients: string[];
}

export interface BulkState {
  phase: BulkPhase;
  instruction: string;
  columns: string[];
  recipientColumn: string | null;
  rows: BulkRow[];
  overLimit: boolean;
  sendRequest: SendRequest | null;
}

export function emptyBulkState(): BulkState {
  return { phase: "idle", instruction: "", columns: [], recipientColumn: null, rows: [], overLimit: false, sendRequest: null };
}

export function initBulk(table: BulkTable, instruction: string, recipientColumn: string | null): BulkState {
  return {
    phase: "idle",
    instruction,
    columns: table.columns,
    recipientColumn,
    overLimit: table.overLimit,
    sendRequest: null,
    rows: table.rows.map((values, index) => {
      const to = rowRecipient(values, recipientColumn);
      return {
        index, values, to,
        status: to ? "queued" : "failed",
        selected: false,
        subject: "", body: "", edited: false, providerDraftId: null,
        error: to ? null : MAIL_AGENT_ERROR_MESSAGES.no_recipient,
      };
    }),
  };
}

function patchRow(state: BulkState, index: number, patch: Partial<BulkRow>): BulkState {
  const row = state.rows[index];
  if (!row) return state;
  const rows = state.rows.slice();
  rows[index] = { ...row, ...patch };
  return { ...state, rows };
}

const errorText = (code: MailAgentErrorCode) => MAIL_AGENT_ERROR_MESSAGES[code];

export const setPhase = (state: BulkState, phase: BulkPhase): BulkState => (state.phase === phase ? state : { ...state, phase });
export const rowGenerating = (state: BulkState, i: number) => patchRow(state, i, { status: "generating", error: null });
export const rowReady = (state: BulkState, i: number, text: { subject: string; body: string }) =>
  patchRow(state, i, { status: "ready", subject: text.subject, body: text.body, selected: true, edited: false, error: null });
export const rowFailed = (state: BulkState, i: number, code: MailAgentErrorCode) => patchRow(state, i, { status: "failed", selected: false, error: errorText(code) });
export const rowCreating = (state: BulkState, i: number) => patchRow(state, i, { status: "creating", error: null });
export const rowCreated = (state: BulkState, i: number, draftId: string) => patchRow(state, i, { status: "created", providerDraftId: draftId, error: null });
export const rowCreateFailed = (state: BulkState, i: number, code: MailAgentErrorCode) => patchRow(state, i, { status: "create_failed", error: errorText(code) });
export const rowSending = (state: BulkState, i: number) => patchRow(state, i, { status: "sending", error: null });
export const rowSent = (state: BulkState, i: number) => patchRow(state, i, { status: "sent", selected: false, error: null });
export const rowSendFailed = (state: BulkState, i: number) => patchRow(state, i, { status: "send_failed", error: "Could not send. Try again." });

/** Rows whose text exists and can be edited. */
const EDITABLE: ReadonlySet<BulkRowStatus> = new Set(["ready", "created", "create_failed", "send_failed"]);
const SELECTABLE: ReadonlySet<BulkRowStatus> = new Set(["ready", "created", "create_failed", "send_failed"]);

/** Owner edits a row: a created draft goes back to ready so the next create replaces it. */
export function editRow(state: BulkState, i: number, patch: { subject?: string; body?: string }): BulkState {
  const row = state.rows[i];
  if (!row || !EDITABLE.has(row.status)) return state;
  const next = patchRow(state, i, {
    ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    edited: true,
    status: "ready",
    error: null,
  });
  return { ...next, sendRequest: null };
}

export function setSelected(state: BulkState, i: number, selected: boolean): BulkState {
  const row = state.rows[i];
  if (!row || row.selected === selected || (selected && !SELECTABLE.has(row.status))) return state;
  return { ...patchRow(state, i, { selected }), sendRequest: null };
}

export function setAllSelected(state: BulkState, selected: boolean): BulkState {
  const rows = state.rows.map((row) => (SELECTABLE.has(row.status) && row.selected !== selected ? { ...row, selected } : row));
  return { ...state, rows, sendRequest: null };
}

/** Rows that "Create drafts" would store. */
export function rowsToCreate(state: BulkState): BulkRow[] {
  return state.rows.filter((row) => row.selected && (row.status === "ready" || row.status === "create_failed"));
}

/** Rows that a send request would cover. */
export function rowsToSend(state: BulkState): BulkRow[] {
  return state.rows.filter((row) => row.selected && (row.status === "created" || row.status === "send_failed") && row.providerDraftId && row.to);
}

export function withSendRequest(state: BulkState, token: string): BulkState {
  const rows = rowsToSend(state);
  if (!rows.length) return { ...state, sendRequest: null };
  return { ...state, sendRequest: { token, rowIndexes: rows.map((row) => row.index), recipients: rows.map((row) => row.to!) } };
}

export const clearSendRequest = (state: BulkState): BulkState => (state.sendRequest ? { ...state, sendRequest: null } : state);

export interface BulkCounts {
  total: number;
  ready: number;
  failed: number;
  selected: number;
  created: number;
  sent: number;
  working: number;
}

export function bulkCounts(state: BulkState): BulkCounts {
  const count = (statuses: BulkRowStatus[]) => state.rows.filter((row) => statuses.includes(row.status)).length;
  return {
    total: state.rows.length,
    ready: count(["ready"]),
    failed: count(["failed", "create_failed", "send_failed"]),
    selected: state.rows.filter((row) => row.selected).length,
    created: count(["created"]),
    sent: count(["sent"]),
    working: count(["queued", "generating", "creating", "sending"]),
  };
}

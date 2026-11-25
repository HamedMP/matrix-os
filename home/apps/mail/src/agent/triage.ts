/**
 * Triage suggestions: the agent proposes a folder, archive, flag or
 * mark-read for each selected thread; the owner reviews the list, unticks
 * what they disagree with and applies the rest with one click through the
 * store's optimistic, undoable triage.
 */
import { formatMailAddress, type MailFolder } from "../../../_shared/office-accounts/types/mail";
import { localId, type ThreadKey } from "../model/ids";
import type { MailStore } from "../model";
import { generateJson, type Validator } from "./ai";
import type { MailAgentContext } from "./context";
import { MailAgentError } from "./errors";
import { MAX_REASON_CHARS, MAX_TRIAGE_THREADS } from "./limits";
import { buildPrompt, type PromptBlock } from "./prompt";
import { oneLineText } from "./untrusted";

export const TRIAGE_ACTIONS = ["archive", "move", "flag", "markRead"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export interface TriageSuggestion {
  id: string;
  key: ThreadKey;
  accountId: string;
  subject: string;
  action: TriageAction;
  /** Set for `move`. */
  folderId?: string;
  folderName?: string;
  /** One line from the model. Render as text. */
  reason: string;
  /** Ticked by default; the owner unticks to leave a thread alone. */
  selected: boolean;
}

export const TRIAGE_SCHEMA = '[{"thread": number, "action": "archive" | "move" | "flag" | "markRead", "folder": number | null /* required for move */, "reason": string /* one short line */}] /* at most one per thread; leave out threads that need nothing */';

/** Folders a thread may be moved into: real containers that are not system boxes. */
export function movableFolders(folders: readonly MailFolder[]): MailFolder[] {
  return folders.filter((folder) => !folder.virtual && (folder.role === "custom" || folder.role === "archive" || folder.role === "inbox"));
}

interface FolderChoice {
  index: number;
  accountId: string;
  folder: MailFolder;
}

export function folderChoices(store: MailStore, accountIds: readonly string[]): FolderChoice[] {
  const state = store.getSnapshot();
  const choices: FolderChoice[] = [];
  for (const accountId of new Set(accountIds)) {
    for (const folder of movableFolders(state.folders[accountId] ?? [])) choices.push({ index: choices.length + 1, accountId, folder });
  }
  return choices;
}

export function triageValidator(keys: readonly ThreadKey[], accountOf: (key: ThreadKey) => string, choices: readonly FolderChoice[]): Validator<Array<{ thread: number; action: TriageAction; folder: FolderChoice | null; reason: string }>> {
  return (value) => {
    const list = Array.isArray(value) ? value : typeof value === "object" && value !== null && Array.isArray((value as { suggestions?: unknown }).suggestions) ? (value as { suggestions: unknown[] }).suggestions : null;
    if (!list) return null;
    const used = new Set<number>();
    const out: Array<{ thread: number; action: TriageAction; folder: FolderChoice | null; reason: string }> = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      const thread = r.thread;
      if (typeof thread !== "number" || !Number.isInteger(thread) || thread < 1 || thread > keys.length || used.has(thread)) continue;
      if (typeof r.action !== "string" || !(TRIAGE_ACTIONS as readonly string[]).includes(r.action)) continue;
      const action = r.action as TriageAction;
      let folder: FolderChoice | null = null;
      if (action === "move") {
        folder = choices.find((choice) => choice.index === r.folder) ?? null;
        if (!folder || folder.accountId !== accountOf(keys[thread - 1])) continue;
      }
      used.add(thread);
      out.push({ thread, action, folder, reason: typeof r.reason === "string" ? r.reason : "" });
    }
    return out;
  };
}

export async function suggestTriage(ctx: MailAgentContext, keys: readonly ThreadKey[], options: { signal?: AbortSignal; instruction?: string } = {}): Promise<TriageSuggestion[]> {
  const state = ctx.store.getSnapshot();
  const targets = [...new Set(keys)].filter((key) => state.threads[key]).slice(0, MAX_TRIAGE_THREADS);
  if (!targets.length) throw new MailAgentError("nothing_selected");
  const accountOf = (key: ThreadKey) => state.threads[key].accountId;
  const choices = folderChoices(ctx.store, targets.map(accountOf));
  const accountName = (id: string) => state.accounts.find((entry) => entry.account.id === id)?.account.address ?? id;
  const folderName = (accountId: string, id: string) => (state.folders[accountId] ?? []).find((folder) => folder.id === id)?.name ?? id;

  const blocks: PromptBlock[] = [
    {
      label: "Folders the threads can be moved into (number: name, account)",
      text: choices.length ? choices.map((c) => `${c.index}: ${oneLineText(c.folder.name, 80)} (${accountName(c.accountId)})`).join("\n") : "(none)",
    },
    ...targets.map((key, i) => {
      const s = state.threads[key];
      return {
        label: `Thread ${i + 1}`,
        from: s.participants.slice(0, 4).map(formatMailAddress).join(", "),
        date: s.lastMessageAt,
        subject: s.subject,
        text: [
          `Account: ${accountName(s.accountId)}`,
          `In: ${s.folderIds.map((id) => folderName(s.accountId, id)).join(", ") || "(none)"}`,
          `Unread: ${s.unread ? "yes" : "no"}; flagged: ${s.flagged ? "yes" : "no"}; attachments: ${s.hasAttachments ? "yes" : "no"}`,
          `Snippet: ${s.snippet}`,
        ].join("\n"),
      };
    }),
  ];
  const prompt = buildPrompt({
    task: "Suggest how the owner could triage each thread: archive it, move it into one of the listed folders, flag it for follow-up, or mark it read.",
    schema: TRIAGE_SCHEMA,
    rules: [
      "Only use folder numbers from the folder list, and only a folder of the thread's own account.",
      "Flag threads that ask the owner to act. Archive finished or purely informational threads. Never suggest deleting anything.",
    ],
    instruction: options.instruction,
    blocks,
  });
  const picked = await generateJson(ctx.ai, prompt, triageValidator(targets, accountOf, choices), TRIAGE_SCHEMA, { signal: options.signal });
  return picked.map(({ thread, action, folder, reason }) => {
    const key = targets[thread - 1];
    const s = state.threads[key];
    return {
      id: localId("triage"),
      key,
      accountId: s.accountId,
      subject: oneLineText(s.subject, 200),
      action,
      ...(folder ? { folderId: folder.folder.id, folderName: oneLineText(folder.folder.name, 80) } : {}),
      reason: oneLineText(reason, MAX_REASON_CHARS),
      selected: true,
    };
  });
}

export interface TriageApplyResult {
  applied: number;
  failed: number;
}

/**
 * Applies the ticked suggestions, grouped into as few store calls as
 * possible (one per action, folder and account). Each group is optimistic
 * and rolled back on its own if the provider refuses it.
 */
export async function applyTriageSuggestions(store: MailStore, suggestions: readonly TriageSuggestion[]): Promise<TriageApplyResult> {
  const groups = new Map<string, { action: TriageAction; folderId?: string; keys: ThreadKey[] }>();
  for (const s of suggestions) {
    if (!s.selected || !store.getSnapshot().threads[s.key]) continue;
    const id = `${s.action}\u001f${s.folderId ?? ""}\u001f${s.accountId}`;
    const group = groups.get(id) ?? { action: s.action, folderId: s.folderId, keys: [] };
    group.keys.push(s.key);
    groups.set(id, group);
  }
  let applied = 0;
  let failed = 0;
  for (const group of groups.values()) {
    let ok: boolean;
    if (group.action === "archive") ok = await store.archive(group.keys);
    else if (group.action === "move" && group.folderId) ok = await store.moveTo(group.folderId, group.keys);
    else if (group.action === "flag") ok = await store.setFlag(true, group.keys);
    else if (group.action === "markRead") ok = await store.markRead(true, group.keys);
    else ok = false;
    if (ok) applied += group.keys.length;
    else failed += group.keys.length;
  }
  return { applied, failed };
}

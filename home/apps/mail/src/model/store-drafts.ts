/**
 * Drafts: compose, reply, reply all, forward, debounced autosave and send.
 *
 * Autosave rules:
 * - A save carries the revision it was made from. When it settles, only the
 *   provider id (and attachment ids, if nothing changed since) is taken from
 *   the reply; the owner's newer local edits are never overwritten.
 * - One save per draft runs at a time; edits made meanwhile trigger one more.
 * - A save never sets `open` or `activeDraftId`: a draft the owner closed
 *   stays closed. A closed draft with unsaved edits is flushed once, then
 *   dropped from memory once clean.
 * - Sending happens only through `sendDraft`, called from an explicit owner
 *   click. It is never retried.
 */
import {
  draftIssues,
  emptyDraft,
  partiallySavedDraft,
  type Draft,
} from "../../../_shared/office-accounts/types/mail";
import { copyAttachments, listedAttachments } from "./draft-attachments";
import { composeDraft, buildDraftFromThread } from "./drafts";
import { draftFromProviderMessage } from "./provider-draft";
import { asMailError, localMailError, toMailError } from "./errors";
import { localId, type ThreadKey } from "./ids";
import type { ListActions } from "./store-lists";
import type { StoreContext } from "./store-core";
import type { DraftKind, DraftState, MailState } from "./types";

/** Drafts open at once. */
export const MAX_OPEN_DRAFTS = 5;
/** Closed drafts kept because their last save failed; the oldest are dropped first. */
export const MAX_UNSAVED_CLOSED_DRAFTS = 10;

export type DraftEdit = Partial<Pick<Draft, "to" | "cc" | "bcc" | "subject" | "bodyHtml" | "bodyText" | "attachments">>;

export interface DraftActions {
  /** Starts an empty draft; returns its local id, or null with an error. */
  compose(accountId?: string): string | null;
  /** Starts a reply, reply-all or forward of a thread (default: the open, else focused thread). */
  respond(kind: Exclude<DraftKind, "new">, options?: { key?: ThreadKey; messageId?: string }): Promise<string | null>;
  /**
   * Opens a draft the provider stores (a message with `draftId` in the thread
   * `key`) for editing; reuses the local draft when one already holds it.
   * `bodyHtml` is editor-safe HTML the UI made from the provider's body.
   */
  editProviderDraft(key: ThreadKey, messageId: string, options?: { bodyHtml?: string }): Promise<string | null>;
  editDraft(localId: string, edit: DraftEdit): void;
  /** Saves now instead of waiting for the debounce. */
  saveDraft(localId: string): Promise<void>;
  /** Closes the draft (navigating away). Unsaved edits are flushed; the draft is never reopened by the store. */
  closeDraft(localId: string): void;
  /** Reopens a draft the owner chose again. */
  openDraft(localId: string): void;
  /** Throws the draft away, also at the provider when it can. */
  discardDraft(localId: string): Promise<void>;
  /** Saves if needed and sends. Call only from an explicit owner click. */
  sendDraft(localId: string): Promise<boolean>;
  dispose(): void;
}

function patchDraft(state: MailState, id: string, patch: Partial<DraftState>): MailState {
  const draft = state.drafts[id];
  return draft ? { ...state, drafts: { ...state.drafts, [id]: { ...draft, ...patch } } } : state;
}

function removeDraft(state: MailState, id: string): MailState {
  if (!state.drafts[id]) return state;
  const drafts = { ...state.drafts };
  delete drafts[id];
  return { ...state, drafts, activeDraftId: state.activeDraftId === id ? null : state.activeDraftId };
}

/** Takes the provider's attachment ids when its list lines up with ours; never drops an attachment. */
function withStoredIds(local: Draft["attachments"], stored: Draft["attachments"] | undefined): Draft["attachments"] {
  if (!stored || stored.length !== local.length) return local;
  return local.map((attachment, i) => (stored[i]?.id && !attachment.id ? { ...attachment, id: stored[i].id } : attachment));
}

/**
 * After a save that failed partway: the provider's new draft id, and the
 * attachment ids it stored when the attachment list has not changed since.
 * Attachments it did not store keep their local content.
 */
function keepPartial(local: Draft, partial: Draft & { id: string }, unchanged: boolean): Draft {
  const attachments = unchanged && partial.attachments.length === local.attachments.length
    ? local.attachments.map((attachment, i) => {
      const stored = partial.attachments[i];
      if (stored?.id) return { ...attachment, id: stored.id };
      const rest = { ...attachment };
      delete rest.id;
      return rest;
    })
    : local.attachments;
  return { ...local, id: partial.id, attachments };
}

/** Drops the oldest closed drafts beyond the cap. */
function capClosed(state: MailState): MailState {
  const closed = Object.values(state.drafts).filter((d) => !d.open && !d.saving && !d.sending);
  if (closed.length <= MAX_UNSAVED_CLOSED_DRAFTS) return state;
  return closed.slice(0, closed.length - MAX_UNSAVED_CLOSED_DRAFTS).reduce((next, d) => removeDraft(next, d.localId), state);
}

export function createDraftActions(ctx: StoreContext, lists: ListActions): DraftActions {
  const timers: Record<string, unknown> = {};
  const inFlight: Partial<Record<string, Promise<void>>> = {};
  const resave: Record<string, true> = {};

  function clearTimer(id: string): void {
    if (timers[id] !== undefined) ctx.timers.clearTimeout(timers[id]);
    delete timers[id];
  }

  function schedule(id: string): void {
    clearTimer(id);
    timers[id] = ctx.timers.setTimeout(() => {
      delete timers[id];
      void save(id);
    }, ctx.autosaveMs);
  }

  function openCount(): number {
    return Object.values(ctx.get().drafts).filter((d) => d.open).length;
  }

  function add(accountId: string, kind: DraftKind, draft: Draft, quote: DraftState["quote"], source: ThreadKey | null): string | null {
    if (openCount() >= MAX_OPEN_DRAFTS) {
      ctx.fail(localMailError("too_many_drafts"));
      return null;
    }
    const id = localId("draft");
    const state: DraftState = {
      localId: id, accountId, kind, sourceThreadKey: source, draft, quote,
      revision: 0, savedRevision: 0, saving: false, sending: false, open: true,
      issues: [], error: null, savedAt: null,
    };
    ctx.set((s) => ({ ...s, drafts: { ...s.drafts, [id]: state }, activeDraftId: id }));
    return id;
  }

  /** Runs one save; settles the in-flight slot and chains another save when edits arrived meanwhile. */
  function save(id: string): Promise<void> {
    const existing = inFlight[id];
    if (existing) {
      resave[id] = true;
      return existing;
    }
    const draft = ctx.get().drafts[id];
    const entry = draft ? ctx.entry(draft.accountId) : undefined;
    if (!draft || !entry || draft.sending) return Promise.resolve();
    if (draft.revision <= draft.savedRevision && draft.draft.id) return Promise.resolve();
    if (draft.revision === 0 && !draft.draft.id) return Promise.resolve();
    const composed = composeDraft(draft);
    const issues = draftIssues(composed);
    if (issues.length) {
      ctx.set((s) => patchDraft(s, id, { issues }));
      return Promise.resolve();
    }
    const revision = draft.revision;
    ctx.set((s) => patchDraft(s, id, { saving: true }));
    const run = (async () => {
      try {
        const stored = await entry.provider.saveDraft(composed);
        const current = ctx.get().drafts[id];
        if (!current) {
          if (stored.id && !draft.draft.id && entry.provider.deleteDraft) await entry.provider.deleteDraft(stored.id);
          return;
        }
        const unchanged = current.revision === revision;
        ctx.set((s) => patchDraft(s, id, {
          saving: false,
          savedRevision: Math.max(current.savedRevision, revision),
          savedAt: ctx.now(),
          error: null,
          draft: { ...current.draft, id: stored.id ?? current.draft.id, attachments: unchanged ? withStoredIds(current.draft.attachments, stored.attachments) : current.draft.attachments },
        }));
      } catch (error: unknown) {
        ctx.log("draft.save.failed", error);
        const mailError = toMailError(error);
        const partial = partiallySavedDraft(error);
        const current = ctx.get().drafts[id];
        if (partial && !current && !draft.draft.id && entry.provider.deleteDraft) {
          try {
            await entry.provider.deleteDraft(partial.id);
          } catch (deleteError: unknown) {
            ctx.log("draft.discard.failed", deleteError);
          }
          return;
        }
        ctx.set((s) => patchDraft(s, id, {
          saving: false,
          error: mailError,
          ...(partial && current ? { draft: keepPartial(current.draft, partial, current.revision === revision) } : {}),
        }));
        delete resave[id];
      }
    })().finally(() => {
      delete inFlight[id];
      const after = ctx.get().drafts[id];
      if (!after) return;
      const dirty = after.revision > after.savedRevision;
      if (resave[id] || (dirty && !after.error)) {
        delete resave[id];
        if (after.open) schedule(id);
        else void save(id);
      } else if (!after.open && !dirty) {
        ctx.set((s) => removeDraft(s, id));
      }
    });
    inFlight[id] = run;
    return run;
  }

  function defaultAccount(): string | undefined {
    const state = ctx.get();
    const view = state.views[state.activeView]?.descriptor;
    if (view?.kind === "folder" && ctx.entry(view.accountId)) return view.accountId;
    const open = state.openThread ? state.threads[state.openThread.key]?.accountId : undefined;
    return open && ctx.entry(open) ? open : ctx.entries()[0]?.account.id;
  }

  return {
    compose(accountId) {
      const id = accountId && ctx.entry(accountId) ? accountId : defaultAccount();
      if (!id) {
        ctx.fail(localMailError("no_account"));
        return null;
      }
      return add(id, "new", emptyDraft(), null, null);
    },

    async respond(kind, options = {}) {
      const state = ctx.get();
      const key = options.key ?? state.openThread?.key ?? state.focused;
      const summary = key ? state.threads[key] : undefined;
      const entry = summary ? ctx.entry(summary.accountId) : undefined;
      if (!key || !summary || !entry) {
        ctx.fail(localMailError(key ? "thread_unavailable" : "nothing_selected"));
        return null;
      }
      if (openCount() >= MAX_OPEN_DRAFTS) {
        ctx.fail(localMailError("too_many_drafts"));
        return null;
      }
      try {
        const thread = await lists.fullThread(key);
        const built = buildDraftFromThread(kind, thread, { owner: entry.account, timeZone: ctx.timeZone, messageId: options.messageId });
        // A forward carries the original's files; it is refused rather than sent without them.
        const attachments = kind === "forward" ? await copyAttachments(entry.provider, built.source, composeDraft(built)) : [];
        return add(entry.account.id, kind, { ...built.draft, attachments }, built.quote, key);
      } catch (error: unknown) {
        ctx.log("draft.respond.failed", error);
        ctx.fail(error instanceof RangeError ? localMailError("thread_unavailable") : asMailError(error));
        return null;
      }
    },

    async editProviderDraft(key, messageId, options = {}) {
      const summary = ctx.get().threads[key];
      const entry = summary ? ctx.entry(summary.accountId) : undefined;
      if (!summary || !entry) {
        ctx.fail(localMailError("thread_unavailable"));
        return null;
      }
      try {
        const thread = await lists.fullThread(key);
        const message = thread.messages.find((m) => m.id === messageId);
        if (!message?.draftId) {
          ctx.fail(localMailError("not_a_draft"));
          return null;
        }
        const local = Object.values(ctx.get().drafts).find((d) => d.accountId === entry.account.id && d.draft.id === message.draftId);
        if (local) {
          if (!local.open && openCount() >= MAX_OPEN_DRAFTS) {
            ctx.fail(localMailError("too_many_drafts"));
            return null;
          }
          ctx.set((s) => patchDraft({ ...s, activeDraftId: local.localId }, local.localId, { open: true }));
          return local.localId;
        }
        if (openCount() >= MAX_OPEN_DRAFTS) {
          ctx.fail(localMailError("too_many_drafts"));
          return null;
        }
        // Outlook keeps stored files on the draft by id; Gmail replaces the whole draft on save, so it needs their content.
        const attachments = entry.account.provider === "outlook"
          ? listedAttachments(message).map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }))
          : await copyAttachments(entry.provider, message, draftFromProviderMessage(thread, message, { ...options, attachments: [] }).draft, { keepIds: true });
        const built = draftFromProviderMessage(thread, message, { bodyHtml: options.bodyHtml, attachments });
        return add(entry.account.id, built.kind, built.draft, null, key);
      } catch (error: unknown) {
        ctx.log("draft.reopen.failed", error);
        ctx.fail(error instanceof RangeError ? localMailError("thread_unavailable") : asMailError(error));
        return null;
      }
    },

    editDraft(id, edit) {
      const draft = ctx.get().drafts[id];
      if (!draft || draft.sending) return;
      const next = { ...draft.draft, ...edit };
      const issues = draftIssues(composeDraft({ draft: next, quote: draft.quote }));
      ctx.set((s) => patchDraft(s, id, { draft: next, revision: draft.revision + 1, issues, error: null }));
      if (ctx.get().drafts[id]?.open) schedule(id);
      else void save(id);
    },

    async saveDraft(id) {
      clearTimer(id);
      await save(id);
    },

    closeDraft(id) {
      const draft = ctx.get().drafts[id];
      if (!draft) return;
      clearTimer(id);
      ctx.set((s) => patchDraft({ ...s, activeDraftId: s.activeDraftId === id ? null : s.activeDraftId }, id, { open: false }));
      const dirty = draft.revision > draft.savedRevision;
      if (dirty) void save(id);
      else if (!draft.saving) ctx.set((s) => removeDraft(s, id));
      ctx.set(capClosed);
    },

    openDraft(id) {
      if (!ctx.get().drafts[id]) return;
      if (!ctx.get().drafts[id].open && openCount() >= MAX_OPEN_DRAFTS) {
        ctx.fail(localMailError("too_many_drafts"));
        return;
      }
      ctx.set((s) => patchDraft({ ...s, activeDraftId: id }, id, { open: true }));
    },

    async discardDraft(id) {
      const draft = ctx.get().drafts[id];
      if (!draft || draft.sending) return;
      clearTimer(id);
      delete resave[id];
      ctx.set((s) => removeDraft(s, id));
      const entry = ctx.entry(draft.accountId);
      const providerId = draft.draft.id;
      if (!providerId || !entry?.provider.deleteDraft) return;
      try {
        await entry.provider.deleteDraft(providerId);
      } catch (error: unknown) {
        ctx.log("draft.discard.failed", error);
        ctx.fail(toMailError(error));
      }
    },

    async sendDraft(id) {
      let draft = ctx.get().drafts[id];
      if (!draft || draft.sending) return false;
      const issues = draftIssues(composeDraft(draft), { forSend: true });
      if (issues.length) {
        ctx.set((s) => patchDraft(s, id, { issues, error: localMailError("draft_invalid") }));
        return false;
      }
      const entry = ctx.entry(draft.accountId);
      if (!entry) {
        ctx.set((s) => patchDraft(s, id, { error: localMailError("no_account") }));
        return false;
      }
      clearTimer(id);
      if (inFlight[id]) await inFlight[id];
      draft = ctx.get().drafts[id];
      if (!draft || draft.sending) return false;
      const snapshot = draft;
      ctx.set((s) => patchDraft(s, id, { sending: true, error: null }));
      try {
        let providerId = snapshot.draft.id;
        if (!providerId || snapshot.revision > snapshot.savedRevision) {
          let stored: Draft;
          try {
            stored = await entry.provider.saveDraft(composeDraft(snapshot));
          } catch (error: unknown) {
            const partial = partiallySavedDraft(error);
            if (partial) ctx.set((s) => patchDraft(s, id, { draft: keepPartial(snapshot.draft, partial, true) }));
            throw error;
          }
          providerId = stored.id;
          ctx.set((s) => patchDraft(s, id, { draft: { ...snapshot.draft, id: providerId }, savedRevision: snapshot.revision }));
        }
        if (!providerId) throw localMailError("draft_invalid");
        await entry.provider.sendDraft(providerId);
        ctx.set((s) => removeDraft(s, id));
        return true;
      } catch (error: unknown) {
        ctx.log("draft.send.failed", error);
        const mailError = asMailError(error);
        ctx.set((s) => patchDraft(s, id, { sending: false, error: mailError }));
        return false;
      }
    },

    dispose() {
      for (const id of Object.keys(timers)) clearTimer(id);
    },
  };
}

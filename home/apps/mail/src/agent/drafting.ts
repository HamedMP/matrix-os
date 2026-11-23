/**
 * Agent drafts in the owner's voice: a reply to a thread or a new message.
 *
 * The draft is written by the model, opened in the composer through the Mail
 * store (which also saves it at the provider) and recorded as a proposal for
 * review. Nothing here sends; sending stays an explicit owner click.
 */
import {
  MAX_DRAFT_SUBJECT_CHARS,
  emptyDraft,
  isValidMailAddress,
  normalizeMailAddress,
  sameMailAddress,
  type MailAccount,
} from "../../../_shared/office-accounts/types/mail";
import { textToHtml } from "../../../_shared/office-accounts/mail/text";
import { localId, type ThreadKey } from "../model/ids";
import { generateJson, type Validator } from "./ai";
import { loadThread, requireAccount, type MailAgentContext } from "./context";
import { MailAgentError } from "./errors";
import { buildPrompt, type PromptBlock } from "./prompt";
import type { DraftProposal } from "./proposals";
import { replyRecipient, threadBlocks } from "./thread-blocks";
import { oneLineText, stripControlChars } from "./untrusted";
import { loadVoiceProfile } from "./voice";
import { voiceContext, voiceExamplesBlock, type VoiceProfile } from "./voice-derive";

export const MAX_DRAFT_BODY_CHARS = 20_000;
export const MAX_DRAFT_TO = 20;

export interface DraftOptions {
  signal?: AbortSignal;
}

export interface ReplyDraftText {
  body: string;
}

export interface NewDraftText {
  to: string[];
  subject: string;
  body: string;
}

export const REPLY_SCHEMA = '{"body": string /* plain text of the reply only: greeting, message, sign-off; no quoted original, no subject line */}';
export const NEW_SCHEMA = '{"to": string[] /* email addresses named by the owner; [] if none */, "subject": string, "body": string /* plain text */}';

function cleanBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const body = stripControlChars(value).replace(/\r\n?/g, "\n").trim();
  return body && body.length <= MAX_DRAFT_BODY_CHARS ? body : null;
}

export const validateReplyText: Validator<ReplyDraftText> = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = cleanBody((value as Record<string, unknown>).body);
  return body ? { body } : null;
};

export const validateNewText: Validator<NewDraftText> = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const body = cleanBody(record.body);
  if (!body || typeof record.subject !== "string") return null;
  const rawTo = Array.isArray(record.to) ? record.to : [];
  const to = [...new Set(rawTo.filter((entry): entry is string => typeof entry === "string").map((entry) => normalizeMailAddress(entry)).filter(isValidMailAddress))].slice(0, MAX_DRAFT_TO);
  return { to, subject: oneLineText(record.subject, MAX_DRAFT_SUBJECT_CHARS), body };
};

/** The drafting prompt; voice traits are trusted context, everything from the mailbox is a block. */
export function buildDraftPrompt(input: { kind: "reply" | "new"; voice: VoiceProfile; owner: MailAccount; instruction?: string; blocks: readonly PromptBlock[] }): string {
  const examples = voiceExamplesBlock(input.voice);
  const ownerName = oneLineText(input.owner.displayName || input.owner.address, 80);
  return buildPrompt({
    task: input.kind === "reply"
      ? `Write ${ownerName}'s reply to the latest message in the conversation below, as ${ownerName} would write it.`
      : `Write a new email from ${ownerName} as described in the owner instruction, as ${ownerName} would write it.`,
    schema: input.kind === "reply" ? REPLY_SCHEMA : NEW_SCHEMA,
    rules: [
      "Follow the owner instruction when there is one; otherwise answer what the latest message asks, briefly.",
      "Match the owner's voice described below: greeting, sign-off, tone, length and language.",
      "Leave a clear placeholder like [date] for any fact you do not know instead of guessing.",
    ],
    context: voiceContext(input.voice),
    instruction: input.instruction,
    blocks: [...(examples ? [examples] : []), ...input.blocks],
  });
}

function proposalFor(ctx: MailAgentContext, fields: Omit<DraftProposal, "id" | "status" | "createdAt" | "saveFailed" | "original">): DraftProposal {
  return { ...fields, id: localId("proposal"), original: "", status: "proposed", saveFailed: false, createdAt: ctx.now() };
}

/** Writes the agent text into a fresh composer draft and saves it at the provider. */
async function fillDraft(ctx: MailAgentContext, localDraftId: string, edit: { to?: string[]; subject?: string; body: string }): Promise<boolean> {
  ctx.store.editDraft(localDraftId, {
    ...(edit.to ? { to: edit.to.map((address) => ({ address })) } : {}),
    ...(edit.subject !== undefined ? { subject: edit.subject } : {}),
    bodyText: edit.body,
    bodyHtml: `<div>${textToHtml(edit.body)}</div>`,
  });
  await ctx.store.saveDraft(localDraftId);
  const saved = ctx.store.getSnapshot().drafts[localDraftId];
  return Boolean(saved && !saved.error && saved.draft.id);
}

/**
 * Drafts a reply to the thread in the owner's voice, opens it in the composer
 * and saves it as a provider draft. Resolves the proposal; never sends.
 */
export async function draftReply(ctx: MailAgentContext, key: ThreadKey, instruction = "", options: DraftOptions = {}): Promise<DraftProposal> {
  const { thread, account, provider } = await loadThread(ctx, key);
  const recipient = replyRecipient(thread, account);
  const voice = await loadVoiceProfile({
    account, provider, recipient, folders: ctx.store.getSnapshot().folders[account.id] ?? [], cache: ctx.voiceCache, now: ctx.now, logger: ctx.log,
  });
  const prompt = buildDraftPrompt({ kind: "reply", voice, owner: account, instruction, blocks: threadBlocks(thread, account) });
  const text = await generateJson(ctx.ai, prompt, validateReplyText, REPLY_SCHEMA, options);
  const draftId = await ctx.store.respond("reply", { key });
  if (!draftId) throw new MailAgentError("draft_unavailable");
  const saved = await fillDraft(ctx, draftId, { body: text.body });
  const draft = ctx.store.getSnapshot().drafts[draftId]?.draft;
  const proposal = proposalFor(ctx, {
    draftLocalId: draftId, kind: "reply", accountId: account.id, threadKey: key,
    subject: draft?.subject ?? thread.subject, to: (draft?.to ?? []).map((entry) => entry.address),
    proposed: text.body, instruction,
  });
  ctx.proposals.add({ ...proposal, saveFailed: !saved });
  return ctx.proposals.get(proposal.id)!;
}

export interface NewDraftOptions extends DraftOptions {
  accountId?: string;
}

/**
 * Drafts a new message from the owner's instruction, opens it in the composer
 * and saves it as a provider draft. Recipients are only addresses the model
 * returned in valid form; the owner reviews them before any send.
 */
export async function draftNew(ctx: MailAgentContext, instruction: string, options: NewDraftOptions = {}): Promise<DraftProposal> {
  const { account, provider } = requireAccount(ctx, options.accountId);
  const named = (instruction.match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+\.[A-Za-z]{2,}/g) ?? []).map(normalizeMailAddress).filter(isValidMailAddress);
  const recipient = named.find((address) => !sameMailAddress(address, account.address)) ?? null;
  const voice = await loadVoiceProfile({
    account, provider, recipient, folders: ctx.store.getSnapshot().folders[account.id] ?? [], cache: ctx.voiceCache, now: ctx.now, logger: ctx.log,
  });
  const prompt = buildDraftPrompt({ kind: "new", voice, owner: account, instruction, blocks: [] });
  const text = await generateJson(ctx.ai, prompt, validateNewText, NEW_SCHEMA, options);
  const to = text.to.filter((address) => !sameMailAddress(address, account.address));
  const draftId = ctx.store.compose(account.id);
  if (!draftId) throw new MailAgentError("draft_unavailable");
  const saved = await fillDraft(ctx, draftId, { to, subject: text.subject, body: text.body });
  const proposal = proposalFor(ctx, {
    draftLocalId: draftId, kind: "new", accountId: account.id, threadKey: null,
    subject: text.subject, to, proposed: text.body, instruction,
  });
  ctx.proposals.add({ ...proposal, saveFailed: !saved });
  return ctx.proposals.get(proposal.id)!;
}

/** The owner keeps the agent draft: it stays a provider draft and is shown in the composer. */
export function keepProposal(ctx: MailAgentContext, proposalId: string): void {
  const proposal = ctx.proposals.get(proposalId);
  if (!proposal || proposal.status !== "proposed") return;
  ctx.proposals.update(proposalId, { status: "accepted" });
  if (ctx.store.getSnapshot().drafts[proposal.draftLocalId]) ctx.store.openDraft(proposal.draftLocalId);
}

/** The owner rejects the agent draft: it is discarded locally and at the provider. */
export async function discardProposal(ctx: MailAgentContext, proposalId: string): Promise<void> {
  const proposal = ctx.proposals.get(proposalId);
  if (!proposal || proposal.status !== "proposed") return;
  ctx.proposals.update(proposalId, { status: "rejected" });
  await ctx.store.discardDraft(proposal.draftLocalId);
}

/** For callers that need an empty draft shape (bulk drafts). */
export function plainDraft(to: string, subject: string, body: string) {
  return { ...emptyDraft(), to: [{ address: to }], subject, bodyText: body, bodyHtml: `<div>${textToHtml(body)}</div>` };
}


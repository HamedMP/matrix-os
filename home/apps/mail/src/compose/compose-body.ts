/**
 * The composer's message body: plain rich text, or a redline when changes
 * are pending.
 *
 * - The owner's typing is applied with `userEdit(finalHtml)`, where
 *   `finalHtml` is what the editor shows with deletions removed. Outside
 *   "Suggest edits" mode the owner's own changes are accepted at once, so
 *   only other authors' changes stay pending; in that mode they stay pending
 *   too, so a draft can be marked up for someone else.
 * - An assistant draft or rewrite arrives through `proposeRewrite`, which
 *   turns its differences from the current text into pending changes.
 * - `draftBody()` is what goes into the store's draft: the degraded markup
 *   while changes are pending, the clean final HTML otherwise.
 *
 * All HTML passes through the redline engine, which keeps only an
 * allowlisted structure, so `markupHtml()` is safe to put in the editor.
 */
import {
  createRedline,
  sanitiseHtml,
  type RedlineChange,
  type TrackedRedline,
} from "../../../_shared/office-engine/redline/index";
import { degradeMarkup, htmlToPlainText, markedText, redlineFromDraftHtml } from "./redline-body";

export interface EditAuthor {
  author: string;
  /** ISO 8601. */
  date: string;
}

export interface DraftBody {
  bodyHtml: string;
  bodyText: string;
}

/** Engine-clean HTML, or "" when it holds no text and no structure worth keeping. */
function cleanHtml(html: string): string {
  const clean = sanitiseHtml(html);
  if (/<(?:ul|ol|table|blockquote|pre)\b/i.test(clean)) return clean;
  return htmlToPlainText(clean).trim() === "" ? "" : clean;
}

export class ComposeBody {
  private redline: TrackedRedline | null;
  private plainHtml: string;
  private suggest = false;
  private cached: RedlineChange[] | null = null;

  private constructor(redline: TrackedRedline | null, plainHtml: string) {
    this.redline = redline;
    this.plainHtml = plainHtml;
  }

  /** The body of a stored draft; tracked markup in it becomes a live redline again. */
  static fromDraftHtml(html: string, now: string): ComposeBody {
    const redline = redlineFromDraftHtml(html, now);
    if (redline && redline.listChanges().length > 0) return new ComposeBody(redline, "");
    return new ComposeBody(null, html ? cleanHtml(redline ? redline.toFinalHtml() : html) : "");
  }

  hasRedline(): boolean {
    return this.redline !== null;
  }

  suggesting(): boolean {
    return this.suggest;
  }

  setSuggesting(on: boolean): void {
    this.suggest = on;
    this.settle();
  }

  finalHtml(): string {
    return this.redline ? this.redline.toFinalHtml() : this.plainHtml;
  }

  finalText(): string {
    return this.redline ? this.redline.toFinalText() : htmlToPlainText(this.plainHtml);
  }

  /** Pending changes in document order. The same array until the body changes. */
  changes(): RedlineChange[] {
    if (!this.cached) this.cached = this.redline ? this.redline.listChanges() : [];
    return this.cached;
  }

  pendingCount(): number {
    return this.changes().length;
  }

  indexOf(id: string): number {
    return this.changes().findIndex((change) => change.id === id);
  }

  /** What the editor shows: the markup view while a redline exists, else the body. */
  markupHtml(): string {
    return this.redline ? this.redline.toHtml("markup") : this.plainHtml;
  }

  /** Applies the owner's edit. Returns false when the text did not change. */
  userEdit(newFinalHtml: string, who: EditAuthor): boolean {
    const next = cleanHtml(newFinalHtml);
    if (next === this.finalHtml()) return false;
    if (!this.redline) {
      if (this.suggest) this.redline = createRedline(this.plainHtml, next, { author: who.author, date: who.date, format: "html" });
      else this.plainHtml = next;
      this.touch();
      return true;
    }
    const before = new Set(this.redline.listChanges().map((change) => change.id));
    this.redline.applyUserEdit(next, who);
    if (!this.suggest) {
      const own = this.redline.listChanges().filter((change) => !before.has(change.id)).map((change) => change.id);
      if (own.length) this.redline.accept(own);
    }
    this.touch();
    this.settle();
    return true;
  }

  /** An assistant draft or rewrite of the whole body, shown as pending changes. */
  proposeRewrite(newHtml: string, who: EditAuthor): void {
    const next = cleanHtml(newHtml);
    if (next === this.finalHtml()) return;
    if (this.redline) this.redline.applyUserEdit(next, who);
    else this.redline = createRedline(this.plainHtml, next, { author: who.author, date: who.date, format: "html" });
    this.touch();
    this.settle();
  }

  accept(ids: readonly string[] | "all"): void {
    this.resolve(ids, true);
  }

  reject(ids: readonly string[] | "all"): void {
    this.resolve(ids, false);
  }

  /** The draft's owner part: marked-up while changes are pending. */
  draftBody(): DraftBody {
    if (this.redline && this.pendingCount() > 0) {
      const markup = this.redline.toHtml("markup");
      return { bodyHtml: degradeMarkup(markup), bodyText: markedText(markup) };
    }
    const html = this.finalHtml();
    return { bodyHtml: html, bodyText: htmlToPlainText(html) };
  }

  private resolve(ids: readonly string[] | "all", accept: boolean): void {
    if (!this.redline) return;
    let target: readonly string[] | "all" = ids;
    if (ids !== "all") {
      const known = new Set(this.changes().map((change) => change.id));
      target = ids.filter((id) => known.has(id));
      if (target.length === 0) return;
    }
    if (accept) this.redline.accept(target);
    else this.redline.reject(target);
    this.touch();
    this.settle();
  }

  /** Drops the redline once nothing is pending and the owner is not suggesting. */
  private settle(): void {
    if (!this.redline || this.suggest || this.redline.listChanges().length > 0) return;
    this.plainHtml = cleanHtml(this.redline.toFinalHtml());
    this.redline = null;
    this.touch();
  }

  private touch(): void {
    this.cached = null;
  }
}

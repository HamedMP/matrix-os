import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type Kysely, sql } from "kysely";
import { z } from "zod/v4";
import type { AppRegistry } from "../app-db-registry.js";
import { parseAppSlug } from "../app-db-types.js";
import type { RequestPrincipal } from "../request-principal.js";
import { appendFact, forgetFact, listFacts } from "../vocal/profile.js";

const text = z.string().trim().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/);
const title = text.max(160);
export const DirectActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open_app"), target: title }).strict(),
  z.object({ type: z.literal("close_app"), target: title }).strict(),
  z.object({ type: z.literal("list_apps") }).strict(),
  z.object({ type: z.literal("create_note"), title, text }).strict(),
  z.object({ type: z.literal("append_note"), title, text }).strict(),
  z.object({ type: z.literal("edit_note"), title, before: text, after: text }).strict(),
  z.object({ type: z.literal("remember"), fact: text }).strict(),
  z.object({ type: z.literal("forget"), fact: text }).strict(),
  z.object({ type: z.literal("list_facts") }).strict(),
]);
export type DirectAction = z.infer<typeof DirectActionSchema>;

/** A complete bounded grammar, not a best-effort NLP interpretation. */
export function classify(input: string): DirectAction | null {
  if (input.length > 2048 || /[\x00-\x1f\x7f]/.test(input)) return null;
  const s = input.trim();
  let action: unknown;
  let m: RegExpMatchArray | null;
  if (/^(?:list apps|what apps do I have|which apps do I have installed)\??$/i.test(s)) action = { type: "list_apps" };
  else if (/^(?:list facts|what do you know about me)\??$/i.test(s)) action = { type: "list_facts" };
  else if ((m = s.match(/^(open|close) (?:my )?([\w -]+?)(?: app)?$/i))) {
    if (/\b(?:and|or|then|it|that|this|them)\b/i.test(m[2])) return null;
    action = { type: `${m[1].toLowerCase()}_app`, target: m[2] };
  } else if ((m = s.match(/^create note "([^"\n]+)" with "([^"\n]+)"$/i))) action = { type: "create_note", title: m[1], text: m[2] };
  else if ((m = s.match(/^append "([^"\n]+)" to note "([^"\n]+)"$/i))) action = { type: "append_note", title: m[2], text: m[1] };
  else if ((m = s.match(/^edit note "([^"\n]+)" replace "([^"\n]+)" with "([^"\n]+)"$/i))) action = { type: "edit_note", title: m[1], before: m[2], after: m[3] };
  else if ((m = s.match(/^forget "([^"\n]+)"$/i))) action = { type: "forget", fact: m[1] };
  else if ((m = s.match(/^remember (.+)$/i))) {
    if (!/^(?:I (?:am|like|prefer|live|work|have)|my [\w ]+ is)\b/i.test(m[1]) || /\b(?:then|and (?:open|close|delete|forget|create))\b/i.test(m[1])) return null;
    action = { type: "remember", fact: m[1] };
  }
  const parsed = DirectActionSchema.safeParse(action);
  return parsed.success ? parsed.data : null;
}

type Status = "ok" | "ambiguous" | "not_found" | "failed";
export interface UiRequest {
  sessionId: string; correlationId: string; phase: "resolve" | "execute";
  action: "open_app" | "close_app"; target: string;
}
export interface UiResult {
  sessionId: string; correlationId: string; phase: "resolve" | "execute";
  status: Status; slug?: string;
}
export interface ActionResult {
  status: Status; message: string; noteId?: string; facts?: string[];
  apps?: { slug: string; name: string }[];
}
export interface ActionOptions {
  principal: RequestPrincipal; ownerId: string; homePath: string;
  registry: AppRegistry; database: Kysely<any>;
  /** Must bind to the invoking active session/socket; resolve has NO window effect. */
  uiAction(request: UiRequest, signal: AbortSignal): Promise<UiResult>;
  notifyDataChange(app: string): Promise<void> | void;
}
interface Node { type?: string; text?: string; content?: Node[]; [key: string]: unknown }
const paragraph = (value: string): Node => ({ type: "paragraph", content: [{ type: "text", text: value }] });
function documentFor(content: string, raw: unknown): Node {
  if (raw && typeof raw === "object" && (raw as Node).type === "doc" && Array.isArray((raw as Node).content)) {
    const doc = structuredClone(raw) as Node;
    // Hydration's empty paragraph must not hide legacy markdown on append.
    if (!content || doc.content!.some(node => node.type !== "paragraph" || Object.keys(node).some(k => k !== "type" && k !== "content") || (node.content?.length ?? 0) > 0)) return doc;
  }
  // Fail closed rather than flatten markdown formatting we cannot faithfully convert.
  if (/[*_`#\[\]<>~]/.test(content)) throw new Error("Rich text unavailable");
  return { type: "doc", content: content ? content.split(/\n\n/).map(paragraph) : [] };
}
function replaceUnique(doc: Node, before: string, after: string): void {
  const matches: Node[] = [];
  let count = 0;
  const visit = (node: Node, depth: number) => {
    if (depth > 64) throw new Error("Document too deep");
    if (typeof node.text === "string") {
      count += node.text.split(before).length - 1;
      if (node.text.includes(before)) matches.push(node);
    }
    for (const child of node.content ?? []) visit(child, depth + 1);
  };
  visit(doc, 0);
  if (count !== 1) throw new Error("Ambiguous rich text edit");
  matches[0].text = matches[0].text!.replace(before, () => after);
}

export class AoedeActions {
  constructor(private readonly options: ActionOptions) {}

  async execute(input: DirectAction, sessionId: string): Promise<ActionResult> {
    const o = this.options;
    if (!o.ownerId || o.principal.userId !== o.ownerId) return { status: "failed", message: "Owner authorization required." };
    const parsed = DirectActionSchema.safeParse(input);
    if (!parsed.success || !sessionId || sessionId.length > 160) return { status: "failed", message: "Invalid action." };
    const a = parsed.data;
    try {
      if (a.type === "list_apps") {
        const apps = (await o.registry.listApps()).filter(x => x.installed_version !== null).map(({ slug, name }) => ({ slug, name }));
        return { status: "ok", message: apps.length ? `Installed apps: ${apps.map(x => x.name).join(", ")}.` : "No apps installed.", apps };
      }
      if (a.type === "open_app" || a.type === "close_app") {
        const request: UiRequest = { sessionId, correlationId: randomUUID(), phase: "resolve", action: a.type, target: a.target };
        const resolved = await this.ui(request);
        if (resolved.status !== "ok") return { status: resolved.status, message: "App could not be resolved." };
        const slug = parseAppSlug(resolved.slug ?? "");
        const app = await o.registry.get(slug);
        if (!app || app.installed_version === null) return { status: "not_found", message: "App is not installed." };
        const effect = await this.ui({ ...request, phase: "execute", target: slug });
        if (effect.status !== "ok" || effect.slug !== slug) return { status: effect.status === "ok" ? "failed" : effect.status, message: "Window effect was not confirmed." };
        return { status: "ok", message: `${app.name} ${a.type === "open_app" ? "opened" : "closed"}.` };
      }
      if (a.type === "list_facts") {
        const facts = await listFacts(o.homePath);
        return { status: "ok", message: facts.length ? `Remembered facts: ${facts.join("; ")}.` : "No remembered facts.", facts };
      }
      if (a.type === "remember" || a.type === "forget") {
        const changed = await (a.type === "remember" ? appendFact : forgetFact)(o.homePath, a.fact);
        return { status: changed || a.type === "remember" ? "ok" : "not_found", message: changed ? "Profile updated." : "Profile unchanged." };
      }
      const schema = await o.registry.getSchema("notes");
      if (!schema.notes || !["title", "content", "content_json"].every(k => k in schema.notes.columns)) throw new Error("Notes storage unavailable");
      const result = await o.database.transaction().execute(async trx => {
        await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
        await sql`SET LOCAL statement_timeout = '3s'`.execute(trx);
        let id: string;
        let content: string;
        let doc: Node;
        if (a.type === "create_note") {
          content = a.text;
          doc = { type: "doc", content: [paragraph(content)] };
          const row = await trx.insertInto("notes.notes").values({ title: a.title, content, content_json: JSON.stringify(doc), pinned: false, tags: "" }).returning("id").executeTakeFirstOrThrow();
          id = row.id;
        } else {
          const rows = await trx.selectFrom("notes.notes").selectAll().where("title", "=", a.title).limit(2).forUpdate().execute();
          if (rows.length !== 1) return { status: rows.length ? "ambiguous" : "not_found", message: "Specify one existing note." } as ActionResult;
          const row = rows[0];
          id = row.id;
          content = row.content ?? "";
          if (content.length > 100_000 || JSON.stringify(row.content_json ?? null).length > 500_000) throw new Error("Note too large");
          doc = documentFor(content, row.content_json);
          if (a.type === "append_note") {
            content = content ? `${content}\n\n${a.text}` : a.text;
            doc.content!.push(paragraph(a.text));
          } else {
            if (content.split(a.before).length !== 2) return { status: "ambiguous", message: "Specify one exact text occurrence." } as ActionResult;
            replaceUnique(doc, a.before, a.after);
            content = content.replace(a.before, () => a.after);
          }
          await trx.updateTable("notes.notes").set({ content, content_json: JSON.stringify(doc), updated_at: sql`now()` }).where("id", "=", id).execute();
        }
        const saved = await trx.selectFrom("notes.notes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
        if (saved.content !== content || !isDeepStrictEqual(saved.content_json, doc)) throw new Error("Note verification failed");
        return { status: "ok", message: "Note saved.", noteId: id } as ActionResult;
      });
      if (result.status === "ok") {
        try { await o.notifyDataChange("notes"); }
        catch (error) { console.warn("[aoede] note refresh notification failed", error); return { ...result, message: "Note saved; refresh notification failed." }; }
      }
      return result;
    } catch (error) {
      console.warn("[aoede] direct action failed", error);
      return { status: "failed", message: "The action could not be confirmed. Do not retry automatically." };
    }
  }

  private async ui(request: UiRequest): Promise<UiResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.options.uiAction(request, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("UI timeout")); }, 2500); }),
      ]);
      if (result.sessionId !== request.sessionId || result.correlationId !== request.correlationId || result.phase !== request.phase || !["ok", "ambiguous", "not_found", "failed"].includes(result.status)) throw new Error("Uncorrelated UI result");
      return result;
    } finally { clearTimeout(timer); }
  }
}

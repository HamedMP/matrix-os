import { AsyncLocalStorage } from "node:async_hooks";
import { PostgresQueryCompiler, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs, type QueryId, type QueryResult, type UnknownRow } from "kysely";

export function barrier() {
  let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}
export async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Actual PG query barrier not reached")), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
type Kind = "preference" | "sourceChat" | "routine" | "other";
type Event = { tag: string; kind: Kind; phase: "attempt" | "locked" };
/** Only two real workload transactions compete. Async query-completion barriers observe their actual
 * PostgreSQL locks; there is no observer connection, replacement SQL, assumed delay, or deadlock retry. */
export class LockOrderTrace implements KyselyPlugin {
  active = false;
  readonly events: Event[] = [];
  readonly #scope = new AsyncLocalStorage<string>();
  readonly #queries = new Map<QueryId, Omit<Event, "phase">>(); // <=128 fixture queries; deleted on completion and close.
  readonly #compiler = new PostgresQueryCompiler();
  before: (event: Event) => void = () => {};
  after: (event: Event) => Promise<void> = async () => {};
  run<T>(tag: string, work: () => T): T { return this.#scope.run(tag, work); }
  transformQuery(args: PluginTransformQueryArgs) {
    const tag = this.#scope.getStore(); if (!this.active || !tag) return args.node;
    if (this.#queries.size >= 128 || this.events.length >= 512) throw new Error("Fixture query trace cap exceeded");
    const query = this.#compiler.compileQuery(args.node, args.queryId), statement = query.sql.toLowerCase();
    const kind: Kind = statement.includes("pg_advisory_xact_lock") && query.parameters.some(value => typeof value === "string" && value.startsWith('["routine-cli-target",')) ? "preference"
      : statement.includes('from "chats"') && statement.endsWith("for share") ? "sourceChat"
        : statement.includes('from "bot_routines"') && statement.endsWith("for update") ? "routine" : "other";
    const event = { tag, kind, phase: "attempt" as const }; this.#queries.set(args.queryId, { tag, kind }); this.events.push(event); this.before(event);
    return args.node;
  }
  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const event = this.#queries.get(args.queryId); this.#queries.delete(args.queryId);
    if (event) { const completed = { ...event, phase: "locked" as const }; this.events.push(completed); await this.after(completed); }
    return args.result;
  }
  close() { this.active = false; this.#queries.clear(); this.events.length = 0; }
}

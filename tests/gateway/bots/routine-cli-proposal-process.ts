/** Built child proof only. Host runtime/model/source callbacks are local fixtures; canonical machinery is real. */
import { OWNER } from "./bot-state-support.js";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
if (!url) throw new Error("Native proposal process PostgreSQL prerequisite missing");
const schema = process.env.MATRIX_ROUTINE_SCHEMA;
if (!schema || !/^bots_[a-f0-9]{32}$/.test(schema)) throw new Error("Parent-owned native schema prerequisite missing");
const db = new Kysely<OwnerBotDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 8,
  options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` }) }) });
let modelCalls = 0;
const f = await proposalFixture(db, fn => (...args) => {
  const first = args[0] as { command?: { kind: string } } | undefined;
  if (first?.command?.kind === "bot.run") modelCalls++;
  return fn(...args);
});
try {
  let lost = false;
  if (process.argv[2] === "lost-ack") f.hooks.transact = async (owner, work) => {
    const result = await f.transact(owner, work);
    const pending = await f.db.selectFrom("routine_cli_proposals").select("client_request_id").where("stage", "=", "pending_approval").executeTakeFirst();
    if (pending && !lost) { lost = true; throw new Error("Synthetic process lost proposal commit ACK"); }
    return result;
  };
  await f.submit(); await f.canonical.drain();
  const dispatch = await f.db.selectFrom("routine_cli_proposals").selectAll().executeTakeFirstOrThrow();
  await f.tasks.abandon({ ownerId: OWNER, taskId: dispatch.task_id! });
  const current = await f.execute({ operation: "request", requestId: dispatch.client_request_id });
  const tasks = await f.db.selectFrom("bot_tasks").select("status").execute();
  const approvals = await f.db.selectFrom("bot_approvals").select("status").execute();
  const routines = await f.db.selectFrom("bot_routines").select("status").execute();
  console.log(JSON.stringify({ proof: "canonical-proposal", current, tasks, approvals, routines, modelCalls, lost }));
} finally { await f.close(); await db.destroy(); }

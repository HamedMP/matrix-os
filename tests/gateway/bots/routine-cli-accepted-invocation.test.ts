import { afterEach, beforeEach, expect, it } from "vitest";
import { createRoutineCliSourceService } from "../../../packages/gateway/src/bots/routine-cli-source.js";
import { context, invocation, SOURCE_SCOPE as scope, control } from "./routine-cli-source-support.js";
import { NOW, at, createBotStateDatabase } from "./bot-state-support.js";
let data: Awaited<ReturnType<typeof createBotStateDatabase>>, clock: string, live: boolean;
const service = () => createRoutineCliSourceService({ db: data.db, scope, now: () => new Date(clock), validateLifecycle: async () => live, authorizeOperation: async () => true });
beforeEach(async () => { data = await createBotStateDatabase(); clock = NOW; live = true; });
afterEach(async () => { await data.destroy(); });
it("validates consumed host invocation after secret cleanup without reusing or extending its token", async () => {
  const svc = service(), source = context(), ref = await svc.register(source);
  const token = (await svc.issue(ref, { invocationId: invocation(1), operation: control })).takeToken();
  const verified = await data.db.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: control }, async (_s, _t, invocation) => invocation));
  clock = at(61000); await svc.cleanup();
  expect((await data.db.selectFrom("routine_cli_capabilities").select("token_hash").executeTakeFirst())!.token_hash).toBeNull();
  expect(await data.db.transaction().execute(trx => svc.validateAcceptedWithin(trx, { source, invocation: verified, operation: control }, async () => "claimed"))).toBe("claimed");
  await expect(data.db.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: control }, async () => "reused"))).rejects.toMatchObject({ code: "permission_denied" });
});
it.each(["revoked", "expired", "unconsumed", "wrong operation", "wrong invocation"] as const)("cannot claim saved %s invocation", async change => {
  const svc = service(), source = context(), ref = await svc.register(source);
  const token = (await svc.issue(ref, { invocationId: invocation(1), operation: control })).takeToken();
  const verified = await data.db.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: control }, async (_s, _t, invocation) => invocation));
  if (change === "revoked") await svc.revoke(ref);
  if (change === "expired") clock = at(300001);
  if (change === "unconsumed") await data.db.updateTable("routine_cli_capabilities").set({ consumed_at: null }).execute();
  let called = false;
  await expect(data.db.transaction().execute(trx => svc.validateAcceptedWithin(trx, { source,
    invocation: change === "wrong invocation" ? { ...verified, invocationId: invocation(2) } : verified,
    operation: change === "wrong operation" ? { ...control, baseRevision: 2 } : control }, async () => { called = true; }))).rejects.toMatchObject({ code: "permission_denied" });
  expect(called).toBe(false);
});

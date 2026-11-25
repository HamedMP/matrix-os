import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { PlatformDB } from "../../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../native-platform-db-test-helper.js";
import { createFakeBridgeHost, json, waitForAbort } from "./fake-bridge-host.js";
import { USER_ID_KEY, createHarness, seedMachines } from "./harness.js";
import { createMessagingBridgeLoginStore } from "../../../packages/platform/src/messaging-bridge/login-store.js";

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const route = (network: string, suffix: string) => new RegExp(`^${escape(`/bridges/${network}/_matrix/provision/v3${suffix}`)}$`);

const QR_STEP = {
  type: "display_and_wait", step_id: "fi.mau.whatsapp.login.qr", txn_id: "bls_qr1",
  instructions: "Scan the QR code", display_and_wait: { type: "qr", data: "2@SHAREDQRPAYLOAD,abc" },
};
const PHONE_STEP = {
  type: "user_input", step_id: "fi.mau.telegram.login.phone", txn_id: "bls_phone",
  user_input: { fields: [{ type: "phone_number", id: "phone_number", name: "Phone number" }] },
};
const CODE_STEP = {
  type: "user_input", step_id: "fi.mau.telegram.login.code", txn_id: "bls_code",
  user_input: { fields: [{ type: "2fa_code", id: "code", name: "Code" }] },
};

/** Two harnesses on one database and one bridge host stand for two Cloud Run instances. */
describe("messaging bridge platform routes: pending logins shared across instances", () => {
  let db: PlatformDB;
  const shutdowns: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await seedMachines(db);
  });

  afterEach(async () => {
    for (const shutdown of shutdowns.splice(0)) await shutdown();
    await destroyTestPlatformDb(db);
  });

  async function instances(options: { now?: () => number; stepWaitMs?: number } = {}) {
    const host = createFakeBridgeHost();
    const first = await createHarness(db, { ...options, host });
    const second = await createHarness(db, { ...options, host });
    shutdowns.push(first.shutdown, second.shutdown);
    return { host, first, second };
  }

  it("advances a login on a different instance than the one that started it", async () => {
    const { host, first, second } = await instances();
    host.on("POST", route("telegram", "/login/start/phone"), () => json({ login_id: "tg1", ...PHONE_STEP }));
    host.on("POST", route("telegram", `/login/step/tg1/${PHONE_STEP.step_id}/user_input`), () => json({ login_id: "tg1", ...CODE_STEP }));
    host.on("POST", route("telegram", `/login/step/tg1/${CODE_STEP.step_id}/user_input`), () =>
      json({ login_id: "tg1", type: "complete", step_id: "done", complete: { user_login_id: "777" } }));

    expect((await first.call("/telegram/login/start", { method: "POST", body: { flowId: "phone" } })).status).toBe(200);
    const phone = await second.call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: PHONE_STEP.step_id, fields: { phone_number: "+15550100" } } });
    expect(phone.status).toBe(200);
    expect(phone.body.step).toMatchObject({ type: "user_input", stepId: CODE_STEP.step_id });

    // Field validation still uses the step the other instance recorded.
    const wrongField = await first.call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: CODE_STEP.step_id, fields: { other: "1" } } });
    expect(wrongField.status).toBe(400);
    const done = await first.call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: CODE_STEP.step_id, fields: { code: "12345" } } });
    expect(done.body.step).toEqual({ type: "complete", loginId: "777" });
    expect((await second.call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: CODE_STEP.step_id, fields: { code: "1" } } })).status).toBe(404);
  });

  it("re-shows a waiting QR step from another instance and cancels it there", async () => {
    const { host, first, second } = await instances({ stepWaitMs: 20 });
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    host.on("POST", route("whatsapp", `/login/step/wa1/${QR_STEP.step_id}/display_and_wait`), (_request, signal) => waitForAbort(signal));
    host.on("POST", route("whatsapp", "/login/cancel/wa1"), () => json({}));

    const started = await first.call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });
    const waited = await second.call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "wa1", stepId: QR_STEP.step_id } });
    expect(waited.status).toBe(200);
    expect(waited.body).toEqual(started.body);

    const cancelled = await first.call("/whatsapp/login/cancel", { method: "POST", body: { loginProcessId: "wa1" } });
    expect(cancelled.body).toEqual({ ok: true });
    expect(host.requests.filter((request) => request.url.pathname.endsWith("/login/cancel/wa1"))).toHaveLength(1);
    expect((await second.call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "wa1", stepId: QR_STEP.step_id } })).status).toBe(404);
  });

  it("never lets another owner advance or cancel a stored login", async () => {
    const { host, first, second } = await instances();
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    await first.call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });
    expect((await second.call("/whatsapp/login/step", { method: "POST", handle: "bob", body: { loginProcessId: "wa1", stepId: QR_STEP.step_id } })).status).toBe(404);
    expect((await second.call("/whatsapp/login/cancel", { method: "POST", handle: "bob", body: { loginProcessId: "wa1" } })).body).toEqual({ ok: true });
    expect(host.requests.filter((request) => request.url.pathname.includes("/login/cancel/"))).toHaveLength(0);
  });

  it("stores the current step encrypted, never in clear text", async () => {
    const { host, first } = await instances();
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    await first.call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });
    const rows = await sql<{ owner_id: string; pending_step: string }>`SELECT owner_id, pending_step FROM messaging_bridge_logins`.execute(db.kysely);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.owner_id).toBe("user_alice");
    expect(rows.rows[0]!.pending_step).not.toContain("SHAREDQRPAYLOAD");
    expect(rows.rows[0]!.pending_step).not.toContain(QR_STEP.step_id);
  });

  it("applies the login-start limit across instances", async () => {
    let clock = Date.parse("2026-11-22T00:00:00.000Z");
    const { host, first, second } = await instances({ now: () => clock });
    let next = 0;
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: `wa${next++}`, ...QR_STEP }));
    for (const instance of [first, second, first, second, first]) {
      expect((await instance.call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } })).status).toBe(200);
    }
    expect((await second.call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } })).status).toBe(429);
    clock += 10 * 60_000 + 1;
    expect((await second.call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } })).status).toBe(200);
  });

  it("keeps at most 16 pending logins per owner and returns the evicted oldest for cancellation", async () => {
    await instances();
    const store = createMessagingBridgeLoginStore(db.kysely as never, USER_ID_KEY);
    const at = Date.parse("2026-11-22T00:00:00.000Z");
    const pending = { stepId: "s", nativeType: "user_input" as const, fieldIds: [{ id: "f", required: true }], step: { type: "user_input" as const, stepId: "s", fields: [{ id: "f", label: "F", kind: "text" as const, required: true }] } };
    const evicted = [];
    for (let index = 0; index < 17; index += 1) {
      evicted.push(...await store.create(`wa${index}`, { ownerId: "user_alice", network: "whatsapp", userId: "@mxo_a:x", pending }, at + index));
    }
    await store.create("bob1", { ownerId: "user_bob", network: "whatsapp", userId: "@mxo_b:x", pending }, at);
    expect(evicted).toEqual([{ processId: "wa0", network: "whatsapp", userId: "@mxo_a:x" }]);
    const rows = await sql<{ owner_id: string; count: string }>`SELECT owner_id, count(*)::text AS count FROM messaging_bridge_logins GROUP BY owner_id ORDER BY owner_id`.execute(db.kysely);
    expect(rows.rows).toEqual([{ owner_id: "user_alice", count: "16" }, { owner_id: "user_bob", count: "1" }]);

    // The shared sweep claims expired rows exactly once.
    const swept = await store.sweep(at + 10 * 60_000 + 20);
    expect(swept).toHaveLength(17);
    expect(await store.sweep(at + 10 * 60_000 + 20)).toEqual([]);
  });

  it("stores a step only over the version it read and never recreates a finished login", async () => {
    await instances();
    const store = createMessagingBridgeLoginStore(db.kysely as never, USER_ID_KEY);
    const at = Date.parse("2026-11-22T00:00:00.000Z");
    const step = (stepId: string) => ({ stepId, nativeType: "user_input" as const, fieldIds: [{ id: "f", required: true }], step: { type: "user_input" as const, stepId, fields: [{ id: "f", label: "F", kind: "text" as const, required: true }] } });
    const base = { ownerId: "user_alice", network: "telegram" as const, userId: "@mxo_a:x" };
    await store.create("tg1", { ...base, pending: step("phone") }, at);
    const read = (await store.get("tg1", "user_alice", "telegram", at)).record!;

    // Another request advances first; the delayed write over the same read loses.
    expect(await store.advance("tg1", { ...base, pending: step("code") }, read.revision, at + 1)).toBe(true);
    expect(await store.advance("tg1", { ...base, pending: step("stale") }, read.revision, at + 2)).toBe(false);
    expect((await store.get("tg1", "user_alice", "telegram", at + 3)).record?.pending.stepId).toBe("code");

    // Another owner never advances it, even with the right revision.
    const current = (await store.get("tg1", "user_alice", "telegram", at + 3)).record!;
    expect(await store.advance("tg1", { ...base, ownerId: "user_bob", pending: step("x") }, current.revision, at + 4)).toBe(false);

    // A cancel wins over a step still waiting at the bridge: the row is not recreated.
    await store.delete("tg1", "user_alice", "telegram");
    expect(await store.advance("tg1", { ...base, pending: step("password") }, current.revision, at + 5)).toBe(false);
    expect(await store.get("tg1", "user_alice", "telegram", at + 6)).toEqual({});
  });

  it("does not sweep a login that a step refreshed before it expired", async () => {
    await instances();
    const store = createMessagingBridgeLoginStore(db.kysely as never, USER_ID_KEY);
    const at = Date.parse("2026-11-22T00:00:00.000Z");
    const pending = { stepId: "s", nativeType: "user_input" as const, fieldIds: [{ id: "f", required: true }], step: { type: "user_input" as const, stepId: "s", fields: [{ id: "f", label: "F", kind: "text" as const, required: true }] } };
    const record = { ownerId: "user_alice", network: "whatsapp" as const, userId: "@mxo_a:x", pending };
    await store.create("wa1", record, at);
    const read = (await store.get("wa1", "user_alice", "whatsapp", at)).record!;
    expect(await store.advance("wa1", record, read.revision, at + 9 * 60_000)).toBe(true);
    expect(await store.sweep(at + 11 * 60_000)).toEqual([]);
    expect((await store.get("wa1", "user_alice", "whatsapp", at + 11 * 60_000)).record).toBeDefined();
  });

  it("refuses a step that finished waiting after another instance cancelled the login", async () => {
    const { host, first, second } = await instances();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    host.on("POST", route("telegram", "/login/start/phone"), () => json({ login_id: "tg1", ...PHONE_STEP }));
    host.on("POST", route("telegram", `/login/step/tg1/${PHONE_STEP.step_id}/user_input`), async () => {
      await held;
      return json({ login_id: "tg1", ...CODE_STEP });
    });
    host.on("POST", route("telegram", "/login/cancel/tg1"), () => json({}));

    await first.call("/telegram/login/start", { method: "POST", body: { flowId: "phone" } });
    const step = first.call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: PHONE_STEP.step_id, fields: { phone_number: "+15550100" } } });
    await vi.waitFor(() => expect(host.requests.some((request) => request.url.pathname.includes("/login/step/tg1/"))).toBe(true));
    expect((await second.call("/telegram/login/cancel", { method: "POST", body: { loginProcessId: "tg1" } })).body).toEqual({ ok: true });
    release();

    const late = await step;
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("conflict");
    const rows = await sql<{ count: string }>`SELECT count(*)::text AS count FROM messaging_bridge_logins`.execute(db.kysely);
    expect(rows.rows[0]!.count).toBe("0");
  });
});

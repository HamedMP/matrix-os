import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MESSAGING_BRIDGE_FIELD_VALUE_MAX, MessagingBridgeLoginProgressSchema } from "@matrix-os/contracts/messaging-bridge";
import type { PlatformDB } from "../../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../native-platform-db-test-helper.js";
import { json } from "./fake-bridge-host.js";
import { createHarness, seedMachines } from "./harness.js";

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const route = (network: string, suffix: string) => new RegExp(`^${escape(`/bridges/${network}/_matrix/provision/v3${suffix}`)}$`);

const QR_STEP = {
  type: "display_and_wait", step_id: "fi.mau.whatsapp.login.qr", txn_id: "bls_qr1",
  instructions: "Scan the QR code", display_and_wait: { type: "qr", data: "2@qr,abc" },
};
const TWELVE_FIELD_STEP = {
  type: "user_input", step_id: "fi.mau.linkedin.login.many", txn_id: "bls_many",
  user_input: { fields: Array.from({ length: 12 }, (_unused, index) => ({ type: "token", id: `f${index}`, name: `Value ${index}` })) },
};
const SELECT_STEP = {
  type: "user_input", step_id: "fi.mau.telegram.login.method", txn_id: "bls_select",
  instructions: "Choose how to receive the code",
  user_input: { fields: [{ type: "select", id: "method", name: "Delivery", options: ["sms", "call", "app"] }] },
};

describe("messaging bridge platform routes: large values, choice fields and cancel", () => {
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

  async function harness() {
    const created = await createHarness(db);
    shutdowns.push(created.shutdown);
    return created;
  }

  it("accepts 12 contract-maximum values, forwards them intact, and refuses anything larger", async () => {
    const { call, host } = await harness();
    host.on("POST", route("linkedin", "/login/start/cookies"), () => json({ login_id: "li1", ...TWELVE_FIELD_STEP }));
    host.on("POST", route("linkedin", `/login/step/li1/${TWELVE_FIELD_STEP.step_id}/user_input`), () =>
      json({ login_id: "li1", type: "complete", step_id: "done", complete: { user_login_id: "ACoAAB1" } }));
    await call("/linkedin/login/start", { method: "POST", body: { flowId: "cookies" } });

    const full = Object.fromEntries(Array.from({ length: 12 }, (_unused, index) => [`f${index}`, "v".repeat(MESSAGING_BRIDGE_FIELD_VALUE_MAX)]));
    const tooLong = await call("/linkedin/login/step", { method: "POST", body: { loginProcessId: "li1", stepId: TWELVE_FIELD_STEP.step_id, fields: { ...full, f0: "v".repeat(MESSAGING_BRIDGE_FIELD_VALUE_MAX + 1) } } });
    expect(tooLong.status).toBe(400);
    const oversized = await call("/linkedin/login/step", { method: "POST", body: { loginProcessId: "li1", stepId: TWELVE_FIELD_STEP.step_id, fields: { ...full, f12: "v".repeat(MESSAGING_BRIDGE_FIELD_VALUE_MAX) } } });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe("invalid_request");
    expect(host.requests).toHaveLength(1);

    const accepted = await call("/linkedin/login/step", { method: "POST", body: { loginProcessId: "li1", stepId: TWELVE_FIELD_STEP.step_id, fields: full } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.step).toEqual({ type: "complete", loginId: "ACoAAB1" });
    expect(host.requests[1].body).toEqual(full);
  });

  it("maps a bridge select input to a choice field and only forwards one of its options", async () => {
    const { call, host } = await harness();
    host.on("POST", route("telegram", "/login/start/phone"), () => json({ login_id: "tg1", ...SELECT_STEP }));
    host.on("POST", route("telegram", `/login/step/tg1/${SELECT_STEP.step_id}/user_input`), () =>
      json({ login_id: "tg1", type: "complete", step_id: "done", complete: { user_login_id: "42" } }));

    const started = await call("/telegram/login/start", { method: "POST", body: { flowId: "phone" } });
    expect(MessagingBridgeLoginProgressSchema.parse(started.body).step).toEqual({
      type: "user_input", stepId: SELECT_STEP.step_id, instructions: SELECT_STEP.instructions,
      fields: [{ id: "method", label: "Delivery", kind: "choice", required: true, options: ["sms", "call", "app"] }],
    });

    const invalid = await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: SELECT_STEP.step_id, fields: { method: "carrier-pigeon" } } });
    expect(invalid.status).toBe(400);
    expect(host.requests).toHaveLength(1);
    const chosen = await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: SELECT_STEP.step_id, fields: { method: "call" } } });
    expect(chosen.body.step.type).toBe("complete");
    expect(host.requests[1].body).toEqual({ method: "call" });
  });

  it.each([
    ["no options", []],
    ["more than 50 options", Array.from({ length: 51 }, (_unused, index) => `option-${index}`)],
    ["an option longer than the contract allows", ["ok", "x".repeat(281)]],
  ])("fails a select input with %s instead of misrepresenting it", async (_label, options) => {
    const { call, host } = await harness();
    host.on("POST", route("telegram", "/login/start/phone"), () => json({
      login_id: "tg1", ...SELECT_STEP, user_input: { fields: [{ type: "select", id: "method", name: "Delivery", options }] },
    }));
    const started = await call("/telegram/login/start", { method: "POST", body: { flowId: "phone" } });
    expect(started.body.step).toEqual({ type: "failed", reason: "unknown" });
  });

  it("cancels the caller's own login at the bridge, idempotently, and leaves other owners' logins alone", async () => {
    const { call, host } = await harness();
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    host.on("POST", route("whatsapp", "/login/cancel/wa1"), () => json({}));
    await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });

    const byOtherOwner = await call("/whatsapp/login/cancel", { method: "POST", handle: "bob", body: { loginProcessId: "wa1" } });
    const onOtherNetwork = await call("/telegram/login/cancel", { method: "POST", body: { loginProcessId: "wa1" } });
    expect([byOtherOwner.body, onOtherNetwork.body]).toEqual([{ ok: true }, { ok: true }]);
    expect(host.requests.filter(request => request.url.pathname.includes("/login/cancel/"))).toHaveLength(0);

    const cancelled = await call("/whatsapp/login/cancel", { method: "POST", body: { loginProcessId: "wa1" } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ ok: true });
    const cancelCalls = host.requests.filter(request => request.url.pathname.endsWith("/login/cancel/wa1"));
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0].url.searchParams.get("user_id")).toMatch(/^@mxo_[0-9a-f]{32}:/);

    const again = await call("/whatsapp/login/cancel", { method: "POST", body: { loginProcessId: "wa1" } });
    expect(again.body).toEqual({ ok: true });
    expect(host.requests.filter(request => request.url.pathname.endsWith("/login/cancel/wa1"))).toHaveLength(1);
    expect((await call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "wa1", stepId: QR_STEP.step_id } })).status).toBe(404);
  });

  it("still answers ok when the bridge cannot cancel", async () => {
    const { call, host, logs } = await harness();
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    host.on("POST", route("whatsapp", "/login/cancel/wa1"), () => json({ errcode: "M_UNKNOWN", error: "boom" }, 500));
    await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });
    const cancelled = await call("/whatsapp/login/cancel", { method: "POST", body: { loginProcessId: "wa1" } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ ok: true });
    expect(logs.join("\n")).toContain("login cancel failed");
    expect((await call("/whatsapp/login/cancel", { method: "POST", body: { loginProcessId: "../x" } })).status).toBe(400);
  });
});

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MessagingBridgeLoginFlowsResponseSchema,
  MessagingBridgeLoginProgressSchema,
  MessagingBridgeLoginsResponseSchema,
} from "@matrix-os/contracts/messaging-bridge";
import type { PlatformDB } from "../../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../native-platform-db-test-helper.js";
import { GATE_SECRET, HOST_URL, PROVISIONING_SECRETS, SERVER_NAME, json, waitForAbort, type RecordedRequest } from "./fake-bridge-host.js";
import { OWNERS, USER_ID_KEY, createHarness, seedMachines } from "./harness.js";

const aliceUserId = `@mxo_${createHmac("sha256", USER_ID_KEY).update(OWNERS.alice.ownerId).digest("hex").slice(0, 32)}:${SERVER_NAME}`;
const provisionPrefix = (network: string) => `/bridges/${network}/_matrix/provision/v3`;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const route = (network: string, suffix: string) => new RegExp(`^${escape(provisionPrefix(network) + suffix)}$`);

const QR_STEP = {
  type: "display_and_wait", step_id: "fi.mau.whatsapp.login.qr", txn_id: "bls_qr1",
  instructions: "Scan the QR code on your phone", display_and_wait: { type: "qr", data: "2@SECRETQRPAYLOAD,abc,def" },
};
const PHONE_STEP = {
  type: "user_input", step_id: "fi.mau.telegram.login.phone", txn_id: "bls_phone",
  instructions: "Enter your phone number",
  user_input: { fields: [{ type: "phone_number", id: "phone_number", name: "Phone number", description: "Include the country code" }] },
};
const CODE_STEP = {
  type: "user_input", step_id: "fi.mau.telegram.login.code", txn_id: "bls_code",
  instructions: "Enter the code Telegram sent you",
  user_input: { fields: [{ type: "2fa_code", id: "code", name: "Code" }] },
};
const PASSWORD_STEP = {
  type: "user_input", step_id: "fi.mau.telegram.login.password", txn_id: "bls_password",
  instructions: "Enter your two-step verification password",
  user_input: { fields: [{ type: "password", id: "password", name: "Password" }] },
};
const PAIRING_CODE_STEP = {
  type: "display_and_wait", step_id: "fi.mau.whatsapp.login.phone_code", txn_id: "bls_pair",
  instructions: "Enter this code in WhatsApp", display_and_wait: { type: "code", data: "ABCD-EFGH" },
};
const COOKIE_STEP = {
  type: "cookies", step_id: "fi.mau.linkedin.login.enter_cookies", txn_id: "bls_cookie",
  instructions: "Enter your cookies",
  cookies: {
    // Shape of the pinned mautrix-linkedin v0.2609.0 (distro/messaging-bridge-host/README.md).
    url: "https://linkedin.com/login",
    user_agent: "Mozilla/5.0",
    wait_for_url_pattern: "^https://www\\.linkedin\\.com/feed.*$",
    fields: [
      { id: "fi.mau.linkedin.login.cookie_header", required: true, sources: [{ type: "request_header", name: "Cookie", request_url_regex: "https://www.linkedin.com" }], pattern: "\\bJSESSIONID=[^;]+" },
      { id: "fi.mau.linkedin.login.x_li_track", required: true, sources: [{ type: "request_header", name: "X-LI-Track", request_url_regex: "https://www.linkedin.com" }], pattern: "clientVersion" },
      { id: "fi.mau.linkedin.login.x_li_page_instance", required: true, sources: [{ type: "request_header", name: "X-LI-Page-Instance", request_url_regex: "https://www.linkedin.com" }], pattern: "urn:li:page" },
    ],
  },
};
const COMPLETE_STEP = (loginId: string) => ({
  type: "complete", step_id: "fi.mau.login.complete", txn_id: "bls_done", instructions: "Logged in", complete: { user_login_id: loginId },
});

describe("messaging bridge platform routes: login flows", () => {
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

  async function harness(options: Parameters<typeof createHarness>[1] = {}) {
    const created = await createHarness(db, options);
    shutdowns.push(created.shutdown);
    return created;
  }

  function expectProvisioningRequest(request: RecordedRequest, network: keyof typeof PROVISIONING_SECRETS, path: string) {
    expect(request.url.origin).toBe(HOST_URL);
    expect(request.url.pathname).toBe(`${provisionPrefix(network)}${path}`);
    expect(request.url.searchParams.get("user_id")).toBe(aliceUserId);
    expect(request.headers.get("authorization")).toBe(`Bearer ${PROVISIONING_SECRETS[network]}`);
    expect(request.headers.get("x-matrix-bridge-gate")).toBe(GATE_SECRET);
  }

  it("lists a network's login flows acting as the owner's derived user", async () => {
    const { call, host } = await harness();
    host.on("GET", route("whatsapp", "/login/flows"), () => json({
      flows: [{ id: "qr", name: "QR code", description: "Scan a QR code" }, { id: "phone", name: "Pairing code", description: "" }],
    }));
    const response = await call("/whatsapp/login/flows");
    expect(response.status).toBe(200);
    expect(MessagingBridgeLoginFlowsResponseSchema.parse(response.body)).toEqual({
      flows: [{ id: "qr", name: "QR code", description: "Scan a QR code" }, { id: "phone", name: "Pairing code" }],
    });
    expectProvisioningRequest(host.requests[0], "whatsapp", "/login/flows");
  });

  it.each([
    ["WhatsApp QR", "whatsapp", "qr", QR_STEP, {
      type: "display_and_wait", stepId: QR_STEP.step_id, instructions: QR_STEP.instructions,
      display: { kind: "qr", data: "2@SECRETQRPAYLOAD,abc,def" },
    }],
    ["WhatsApp pairing code", "whatsapp", "phone", PAIRING_CODE_STEP, {
      type: "display_and_wait", stepId: PAIRING_CODE_STEP.step_id, instructions: PAIRING_CODE_STEP.instructions,
      display: { kind: "code", data: "ABCD-EFGH" },
    }],
    ["Telegram phone", "telegram", "phone", PHONE_STEP, {
      type: "user_input", stepId: PHONE_STEP.step_id, instructions: PHONE_STEP.instructions,
      fields: [{ id: "phone_number", label: "Phone number", description: "Include the country code", kind: "phone", required: true }],
    }],
    ["Telegram password", "telegram", "phone", PASSWORD_STEP, {
      type: "user_input", stepId: PASSWORD_STEP.step_id, instructions: PASSWORD_STEP.instructions,
      fields: [{ id: "password", label: "Password", kind: "secret", required: true }],
    }],
    ["LinkedIn cookies", "linkedin", "cookies", COOKIE_STEP, {
      type: "user_input", stepId: COOKIE_STEP.step_id, instructions: COOKIE_STEP.instructions,
      helpUrl: "https://linkedin.com/login",
      fields: [
        { id: "fi.mau.linkedin.login.cookie_header", label: "Cookie request header", kind: "secret", required: true },
        { id: "fi.mau.linkedin.login.x_li_track", label: "X-LI-Track request header", kind: "secret", required: true },
        { id: "fi.mau.linkedin.login.x_li_page_instance", label: "X-LI-Page-Instance request header", kind: "secret", required: true },
      ],
    }],
    ["an unsupported passkey step", "telegram", "phone", { type: "webauthn", step_id: "x", txn_id: "bls_w", webauthn: {} }, {
      type: "failed", reason: "unknown",
    }],
  ])("normalizes a %s step", async (_label, network, flowId, native, expected) => {
    const { call, host } = await harness();
    host.on("POST", route(network, `/login/start/${flowId}`), () => json({ login_id: "proc1", ...native }));
    const response = await call(`/${network}/login/start`, { method: "POST", body: { flowId } });
    expect(response.status).toBe(200);
    expect(MessagingBridgeLoginProgressSchema.parse(response.body)).toEqual({ loginProcessId: "proc1", step: expected });
    expectProvisioningRequest(host.requests[0], network as keyof typeof PROVISIONING_SECRETS, `/login/start/${flowId}`);
  });

  it("offers and starts only flows an owner can finish in the dialog", async () => {
    const { call, host } = await harness();
    host.on("GET", route("telegram", "/login/flows"), () => json({ flows: [
      { id: "phone", name: "Phone number", description: "" }, { id: "qr", name: "QR code", description: "" },
      { id: "bot", name: "Bot token", description: "" }, { id: "manual", name: "Manual", description: "advanced, do not use" },
    ] }));
    const flows = await call("/telegram/login/flows");
    expect(flows.body.flows.map((flow: { id: string }) => flow.id)).toEqual(["phone", "qr"]);

    for (const flowId of ["bot", "manual"]) {
      const refused = await call("/telegram/login/start", { method: "POST", body: { flowId } });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe("invalid_request");
    }
    expect((await call("/whatsapp/login/start", { method: "POST", body: { flowId: "cookies" } })).status).toBe(400);
    expect(host.requests).toHaveLength(1);
    expect(host.loginIdLookups).toHaveLength(0);
  });

  it("re-links the owner's existing login in place and starts fresh when there is none", async () => {
    const { call, host } = await harness();
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    host.on("POST", route("telegram", "/login/start/phone"), () => json({ login_id: "tg1", ...PHONE_STEP }));
    host.loginIds.whatsapp = ["15550100"];

    await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });
    await call("/telegram/login/start", { method: "POST", body: { flowId: "phone" } });

    const [relink, fresh] = host.requests;
    expect(relink.url.searchParams.get("login_id")).toBe("15550100");
    expect(relink.url.searchParams.get("user_id")).toBe(aliceUserId);
    expect(fresh.url.searchParams.has("login_id")).toBe(false);
    expect(host.loginIdLookups.map(request => request.url.pathname)).toEqual([
      `${provisionPrefix("whatsapp")}/logins`, `${provisionPrefix("telegram")}/logins`,
    ]);
    expect(host.loginIdLookups[0].url.searchParams.get("user_id")).toBe(aliceUserId);
  });

  it("starts the bridge's first flow when no flow is named", async () => {
    const { call, host } = await harness();
    host.on("GET", route("whatsapp", "/login/flows"), () => json({ flows: [{ id: "qr", name: "QR", description: "" }] }));
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "proc1", ...QR_STEP }));
    const response = await call("/whatsapp/login/start", { method: "POST", body: {} });
    expect(response.body.step.type).toBe("display_and_wait");
  });

  it("drives a Telegram phone, code and password login to completion through the native step paths", async () => {
    const { call, host } = await harness();
    host.on("POST", route("telegram", "/login/start/phone"), () => json({ login_id: "tg1", ...PHONE_STEP }));
    host.on("POST", route("telegram", `/login/step/tg1/${PHONE_STEP.step_id}/user_input`), () => json({ login_id: "tg1", ...CODE_STEP }));
    host.on("POST", route("telegram", `/login/step/tg1/${CODE_STEP.step_id}/user_input`), () => json({ login_id: "tg1", ...PASSWORD_STEP }));
    host.on("POST", route("telegram", `/login/step/tg1/${PASSWORD_STEP.step_id}/user_input`), () => json({ login_id: "tg1", ...COMPLETE_STEP("4815162342") }));

    await call("/telegram/login/start", { method: "POST", body: { flowId: "phone" } });
    const code = await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: PHONE_STEP.step_id, fields: { phone_number: "+15550100" } } });
    expect(code.body.step).toMatchObject({ type: "user_input", stepId: CODE_STEP.step_id, fields: [{ id: "code", kind: "code" }] });
    const password = await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: CODE_STEP.step_id, fields: { code: "12345" } } });
    expect(password.body.step.stepId).toBe(PASSWORD_STEP.step_id);
    const done = await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: PASSWORD_STEP.step_id, fields: { password: "hunter2-secret" } } });
    expect(done.body).toEqual({ loginProcessId: "tg1", step: { type: "complete", loginId: "4815162342" } });

    const phoneSubmit = host.requests[1];
    expectProvisioningRequest(phoneSubmit, "telegram", `/login/step/tg1/${PHONE_STEP.step_id}/user_input`);
    expect(phoneSubmit.url.searchParams.get("txn_id")).toBe("bls_phone");
    expect(phoneSubmit.body).toEqual({ phone_number: "+15550100" });
    expect(host.requests[3].body).toEqual({ password: "hunter2-secret" });

    // A completed process is forgotten; replaying it cannot reach the bridge again.
    const replay = await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: PASSWORD_STEP.step_id, fields: { password: "x" } } });
    expect(replay.status).toBe(404);
    expect(host.requests).toHaveLength(4);
  });

  it("submits cookie-style values to the bridge's cookies step and validates the declared fields", async () => {
    const { call, host } = await harness();
    host.on("POST", route("linkedin", "/login/start/cookies"), () => json({ login_id: "li1", ...COOKIE_STEP }));
    host.on("POST", route("linkedin", `/login/step/li1/${COOKIE_STEP.step_id}/cookies`), () => json({ login_id: "li1", ...COMPLETE_STEP("ACoAAB123") }));
    await call("/linkedin/login/start", { method: "POST", body: { flowId: "cookies" } });

    const unknownField = await call("/linkedin/login/step", { method: "POST", body: { loginProcessId: "li1", stepId: COOKIE_STEP.step_id, fields: { "fi.mau.linkedin.login.cookie_header": "a", "fi.mau.linkedin.login.x_li_track": "b", other: "c" } } });
    expect(unknownField.status).toBe(400);
    const missingRequired = await call("/linkedin/login/step", { method: "POST", body: { loginProcessId: "li1", stepId: COOKIE_STEP.step_id, fields: { "fi.mau.linkedin.login.cookie_header": "a" } } });
    expect(missingRequired.status).toBe(400);
    expect(missingRequired.body.error.code).toBe("invalid_request");
    expect(host.requests).toHaveLength(1);

    const cookies = {
      "fi.mau.linkedin.login.cookie_header": "li_at=SECRETCOOKIE; JSESSIONID=ajax",
      "fi.mau.linkedin.login.x_li_track": "{\"clientVersion\":\"1\"}",
      "fi.mau.linkedin.login.x_li_page_instance": "urn:li:page:d_flagship3_feed;abc",
    };
    const done = await call("/linkedin/login/step", { method: "POST", body: { loginProcessId: "li1", stepId: COOKIE_STEP.step_id, fields: cookies } });
    expect(done.body.step).toEqual({ type: "complete", loginId: "ACoAAB123" });
    expect(host.requests[1].body).toEqual(cookies);
    expect(host.requests[1].url.searchParams.get("txn_id")).toBe("bls_cookie");
  });

  it("long-polls a display_and_wait step, returns it unchanged when the wait elapses, then reports the scan", async () => {
    const { call, host } = await harness({ stepWaitMs: 40 });
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    let scanned = false;
    host.on("POST", route("whatsapp", `/login/step/wa1/${QR_STEP.step_id}/display_and_wait`), (_request, signal) =>
      scanned ? json({ login_id: "wa1", ...COMPLETE_STEP("15550100") }) : waitForAbort(signal));
    await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });

    const started = Date.now();
    const pending = await call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "wa1", stepId: QR_STEP.step_id } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(pending.status).toBe(200);
    expect(pending.body.step).toMatchObject({ type: "display_and_wait", stepId: QR_STEP.step_id, display: { kind: "qr" } });
    expect(host.requests[1].url.searchParams.get("txn_id")).toBe("bls_qr1");
    expect(host.requests[1].body).toBeUndefined();

    scanned = true;
    const done = await call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "wa1", stepId: QR_STEP.step_id } });
    expect(done.body.step).toEqual({ type: "complete", loginId: "15550100" });
  });

  it("rejects fields on a display_and_wait step and a stale step id", async () => {
    const { call, host } = await harness();
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });
    const withFields = await call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "wa1", stepId: QR_STEP.step_id, fields: { x: "y" } } });
    expect(withFields.status).toBe(400);
    const stale = await call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "wa1", stepId: "fi.mau.old" } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
    expect(host.requests).toHaveLength(1);
  });

  it("refuses a login process id that belongs to another owner or network", async () => {
    const { call, host } = await harness();
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });
    const otherOwner = await call("/whatsapp/login/step", { method: "POST", handle: "bob", body: { loginProcessId: "wa1", stepId: QR_STEP.step_id } });
    const otherNetwork = await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "wa1", stepId: QR_STEP.step_id } });
    const unknown = await call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "never-started", stepId: QR_STEP.step_id } });
    for (const response of [otherOwner, otherNetwork, unknown]) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("not_found");
    }
    expect(host.requests).toHaveLength(1);
  });

  it("cancels an abandoned login at the bridge once it expires and then refuses it", async () => {
    let clock = Date.parse("2026-11-22T00:00:00.000Z");
    const { call, host } = await harness({ now: () => clock });
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    host.on("POST", route("whatsapp", "/login/cancel/wa1"), () => json({}));
    await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });

    clock += 10 * 60_000 + 1;
    const late = await call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "wa1", stepId: QR_STEP.step_id } });
    expect(late.status).toBe(404);
    await new Promise(resolve => setTimeout(resolve, 0));
    const cancel = host.requests.find(request => request.url.pathname.endsWith("/login/cancel/wa1"));
    expect(cancel).toBeDefined();
    expectProvisioningRequest(cancel!, "whatsapp", "/login/cancel/wa1");
    expect(host.requests.filter(request => request.url.pathname.includes("/login/step/"))).toHaveLength(0);
  });

  it("limits login starts to 5 per owner per 10 minutes without calling the bridge", async () => {
    let clock = Date.parse("2026-11-22T00:00:00.000Z");
    const { call, host } = await harness({ now: () => clock });
    let next = 0;
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: `wa${next++}`, ...QR_STEP }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } })).status).toBe(200);
    }
    const limited = await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(host.requests).toHaveLength(5);
    expect((await call("/whatsapp/login/start", { method: "POST", handle: "bob", body: { flowId: "qr" } })).status).toBe(200);

    clock += 10 * 60_000 + 1;
    expect((await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } })).status).toBe(200);
  });

  it("projects bridge step errors onto failed steps and forgets the dead process", async () => {
    const { call, host } = await harness();
    host.on("POST", route("telegram", "/login/start/phone"), () => json({ login_id: "tg1", ...PHONE_STEP }));
    host.on("POST", route("telegram", `/login/step/tg1/${PHONE_STEP.step_id}/user_input`), () =>
      json({ errcode: "FI.MAU.BRIDGE.LOGIN_TIMED_OUT", error: "Login process timed out" }, 410));
    await call("/telegram/login/start", { method: "POST", body: { flowId: "phone" } });
    const expired = await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: PHONE_STEP.step_id, fields: { phone_number: "+15550100" } } });
    expect(expired.body).toEqual({ loginProcessId: "tg1", step: { type: "failed", reason: "expired" } });
    expect((await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: PHONE_STEP.step_id, fields: { phone_number: "1" } } })).status).toBe(404);

    host.on("POST", route("telegram", "/login/start/phone"), () => json({ login_id: "tg2", ...PHONE_STEP }));
    host.on("POST", route("telegram", `/login/step/tg2/${PHONE_STEP.step_id}/user_input`), () =>
      json({ errcode: "FI.MAU.TELEGRAM.PHONE_NUMBER_INVALID", error: "Invalid phone number" }, 400));
    await call("/telegram/login/start", { method: "POST", body: { flowId: "phone" } });
    const rejected = await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg2", stepId: PHONE_STEP.step_id, fields: { phone_number: "+1" } } });
    expect(rejected.body.step).toEqual({ type: "failed", reason: "rejected" });
  });

  it("returns fixed error bodies and never logs secrets, QR payloads or field values", async () => {
    const { call, host, logs } = await harness();
    host.on("POST", route("whatsapp", "/login/start/qr"), () => json({ login_id: "wa1", ...QR_STEP }));
    host.on("POST", route("telegram", "/login/start/phone"), () => json({ login_id: "tg1", ...PHONE_STEP }));
    host.on("POST", route("telegram", `/login/step/tg1/${PHONE_STEP.step_id}/user_input`), () =>
      json({ errcode: "M_UNKNOWN", error: `crash with +15550199 and ${PROVISIONING_SECRETS.telegram}` }, 500));
    host.on("GET", route("linkedin", "/whoami"), () => { throw new Error(`connect failed ${HOST_URL} ${PROVISIONING_SECRETS.linkedin}`); });

    await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr" } });
    await call("/telegram/login/start", { method: "POST", body: { flowId: "phone" } });
    const crashed = await call("/telegram/login/step", { method: "POST", body: { loginProcessId: "tg1", stepId: PHONE_STEP.step_id, fields: { phone_number: "+15550199" } } });
    expect(crashed.body.step).toEqual({ type: "failed", reason: "unknown" });
    const unreachable = await call("/linkedin/logins");
    expect(unreachable.status).toBe(502);
    expect(unreachable.body).toEqual({ error: { code: "bridge_unavailable", message: expect.any(String) } });
    expect(unreachable.text).not.toMatch(/linkedin|mautrix|bridge\.example/i);

    const logged = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [...Object.values(PROVISIONING_SECRETS), GATE_SECRET, "+15550199", "SECRETQRPAYLOAD"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("reports logins with their state and logs one out for the owner", async () => {
    const { call, host } = await harness();
    host.on("GET", route("whatsapp", "/whoami"), () => json({
      network: { displayname: "WhatsApp" }, login_flows: [], homeserver: SERVER_NAME, bridge_bot: "@whatsappbot:x", command_prefix: "!wa",
      logins: [
        { id: "15550100", name: "+1 555 0100", state: { state_event: "CONNECTED", timestamp: 1 }, profile: {} },
        { id: "15550101", name: "Work", state: { state_event: "BAD_CREDENTIALS", timestamp: 1 }, profile: {} },
        { id: "15550102", name: "", state: { state_event: "TRANSIENT_DISCONNECT", timestamp: 1 }, profile: {} },
      ],
    }));
    host.on("POST", route("whatsapp", "/logout/15550100"), () => json({}));
    host.on("POST", route("whatsapp", "/logout/gone"), () => json({ errcode: "M_NOT_FOUND", error: "Login not found" }, 404));

    const logins = await call("/whatsapp/logins");
    expect(MessagingBridgeLoginsResponseSchema.parse(logins.body)).toEqual({
      logins: [
        { loginId: "15550100", displayName: "+1 555 0100", state: "connected" },
        { loginId: "15550101", displayName: "Work", state: "needs_relink" },
        { loginId: "15550102", state: "connecting" },
      ],
    });
    expectProvisioningRequest(host.requests[0], "whatsapp", "/whoami");

    const logout = await call("/whatsapp/logout", { method: "POST", body: { loginId: "15550100" } });
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ ok: true });
    expectProvisioningRequest(host.requests[1], "whatsapp", "/logout/15550100");
    expect((await call("/whatsapp/logout", { method: "POST", body: { loginId: "gone" } })).status).toBe(404);
    const all = await call("/whatsapp/logout", { method: "POST", body: { loginId: "all" } });
    expect(all.status).toBe(400);
    expect(host.requests).toHaveLength(3);
  });

  it("rejects malformed params and bodies at the route boundary", async () => {
    const { call, host } = await harness();
    expect((await call("/signal/login/flows")).status).toBe(400);
    expect((await call("/whatsapp/login/start", { method: "POST", body: "{not json" })).status).toBe(400);
    expect((await call("/whatsapp/login/start", { method: "POST", body: { flowId: "qr", extra: 1 } })).status).toBe(400);
    expect((await call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "../x", stepId: "s" } })).status).toBe(400);
    expect((await call("/whatsapp/login/start", { method: "POST", body: { flowId: "x".repeat(70_000) } })).status).toBe(413);
    expect(host.requests).toHaveLength(0);
  });
});

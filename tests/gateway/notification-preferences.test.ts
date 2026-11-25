import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES, NotificationPreferencesSchema } from "@matrix-os/contracts";
import { createNotificationPreferenceStore } from "../../packages/gateway/src/notifications/preferences-store.js";
import { createNotificationPreferenceRoutes } from "../../packages/gateway/src/notifications/routes.js";
import { createCodingAgentNotificationPreferenceStore } from "../../packages/gateway/src/coding-agents/notification-preferences.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { markAuthContextReady, type RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const principal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const path = "/api/notifications/preferences";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-notification-prefs-"));
  homes.push(homePath);
  const store = createNotificationPreferenceStore({ homePath, ownerIds: [principal.userId] });
  const legacy = createCodingAgentNotificationPreferenceStore({ homePath, preferences: store });
  const app = new Hono();
  let activePrincipal = principal;
  app.route("/api/notifications", createNotificationPreferenceRoutes({ store, getPrincipal: () => activePrincipal }));
  app.route("/api/coding-agents", createCodingAgentRoutes({
    service: { getSummary: async () => { throw new Error("not used"); } },
    notificationPreferences: legacy, getPrincipal: () => activePrincipal,
  }));
  return { homePath, app, store, legacy, setPrincipal: (next: RequestPrincipal) => { activePrincipal = next; } };
}
async function put(app: Hono, body: unknown, route = path) {
  const etag = route === path ? null : (await app.request(route)).headers.get("etag") ?? '"0"';
  return app.request(route, { method: "PUT", headers: { "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) }, body: JSON.stringify(body) });
}
const defaults = () => structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);

// Goal: client saves remain strict, portable and privacy-preserving; reject silent policy drift.
describe("notification preferences contract", () => {
  it("requires a complete strict document, version and safe revision", () => {
    expect(NotificationPreferencesSchema.parse(defaults())).toEqual({
      version: 1, revision: 0,
      events: { approval: true, question: true, replyFinished: true, runFailed: true, minReplySeconds: 10 },
      phone: { mode: "when_away", awayAfterSeconds: 180, replyDelaySeconds: 60 },
      content: { showPreview: false, sound: true, timeSensitive: false },
    });
    for (const body of [{}, { ...defaults(), version: 2 }, { ...defaults(), revision: -1 },
      { ...defaults(), revision: Number.MAX_SAFE_INTEGER + 1 }, { ...defaults(), ownerId: "other" },
      { ...defaults(), content: { ...defaults().content, extra: true } },
      { ...defaults(), events: { approval: true } }, { ...defaults(), phone: { ...defaults().phone, mode: "sometimes" } }]) {
      expect(NotificationPreferencesSchema.safeParse(body).success).toBe(false);
    }
  });
  it.each([
    ["events", "minReplySeconds", [0, 10, 30, 60, 300]],
    ["phone", "awayAfterSeconds", [60, 180, 300, 600, 900]],
    ["phone", "replyDelaySeconds", [0, 30, 60, 120, 300]],
  ] as const)("only accepts the specified %s.%s choices", (section, key, choices) => {
    for (const value of [...choices, 11, -1, 0.5]) {
      const body = defaults();
      Object.assign(body[section], { [key]: value });
      expect(NotificationPreferencesSchema.safeParse(body).success).toBe((choices as readonly number[]).includes(value));
    }
  });
});

// Boundary: real Hono routes, shared store and real filesystem; no simulated persistence/locking.
describe("owner notification preferences API", () => {
  it("seeds defaults once and survives a store restart", async () => {
    const { homePath, app } = await fixture();
    expect(await (await app.request(path)).json()).toEqual({ preferences: defaults() });
    expect(JSON.parse(await readFile(join(homePath, "system/notifications.json"), "utf8"))).toEqual(defaults());
    const restarted = createNotificationPreferenceStore({ homePath, ownerIds: [principal.userId] });
    expect(await restarted.load(principal)).toEqual(defaults());
  });
  it("migrates only the runtime owner's choices, with privacy switches off", async () => {
    const { homePath, app } = await fixture();
    const directory = join(homePath, "system/coding-agents/notification-preferences");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "owner_user.json"), JSON.stringify({ attentionPush: { approval: false, input: true, failed: false } }));
    await writeFile(join(directory, "other_user.json"), JSON.stringify({ attentionPush: { approval: true, input: false, failed: true, completed: false } }));
    const expected = defaults();
    expected.events.approval = false;
    expected.events.runFailed = false;
    expect(await (await app.request(path)).json()).toEqual({ preferences: expected });
    await writeFile(join(directory, "owner_user.json"), "broken legacy after migration");
    expect(await (await app.request(path)).json()).toEqual({ preferences: expected });
  });
  it("serializes concurrent revision checks across store instances, leaving one durable winner", async () => {
    const { homePath, store } = await fixture();
    const second = createNotificationPreferenceStore({ homePath, ownerIds: [principal.userId] });
    const one = defaults(); one.content.showPreview = true;
    const two = defaults(); two.phone.mode = "never";
    const results = await Promise.allSettled([store.save(principal, one), second.save(principal, two)]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const winner = results.find(result => result.status === "fulfilled");
    const loser = results.find(result => result.status === "rejected");
    expect(loser?.status === "rejected" && loser.reason.code).toBe("notification_preferences_conflict");
    expect(winner?.status === "fulfilled" && winner.value.revision).toBe(1);
    expect(await store.load(principal)).toEqual(winner?.status === "fulfilled" && winner.value);
  });
  it("returns a generic 409 for a stale full-document save", async () => {
    const { app } = await fixture();
    const first = await put(app, defaults());
    expect(first.status).toBe(200);
    expect((await first.json()).preferences.revision).toBe(1);
    const stale = await put(app, defaults());
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("notification_preferences_conflict");
  });
  it("rejects stale or unconditional legacy replacements after a mobile edit", async () => {
    const { app } = await fixture();
    const legacyPath = "/api/coding-agents/notification-preferences";
    const oldDocument = (await (await app.request(legacyPath)).json()).preferences;
    const mobile = defaults(); mobile.events.approval = false;
    expect((await put(app, mobile)).status).toBe(200);
    oldDocument.attentionPush.completed = false;
    const legacyPut = (etag?: string) => app.request(legacyPath, { method: "PUT",
      headers: { "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) }, body: JSON.stringify(oldDocument) });
    expect((await legacyPut('"0"')).status).toBe(409);
    expect((await legacyPut()).status).toBe(409);
    const latest = await app.request(legacyPath);
    expect(latest.headers.get("etag")).toBe('"1"');
    expect((await latest.json()).preferences.attentionPush.approval).toBe(false);
    expect((await legacyPut('"1"')).status).toBe(200);
  });
  it("serializes the revision precondition for concurrent legacy replacements", async () => {
    const { app } = await fixture();
    const route = "/api/coding-agents/notification-preferences";
    const initial = await app.request(route);
    const base = (await initial.json()).preferences;
    const requests = [{ attentionPush: { ...base.attentionPush, approval: false } },
      { attentionPush: { ...base.attentionPush, completed: false } }];
    const responses = await Promise.all(requests.map(body => app.request(route, { method: "PUT",
      headers: { "content-type": "application/json", "if-match": initial.headers.get("etag")! }, body: JSON.stringify(body) })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = await responses.find(response => response.status === 200)!.json();
    expect(await (await app.request(route)).json()).toEqual(winner);
    expect((await (await app.request(path)).json()).preferences.revision).toBe(1);
  });
  it("patches only supplied legacy switches without defaulting disabled switches back on", async () => {
    const { app } = await fixture();
    const document = defaults();
    Object.assign(document.events, { approval: false, question: false, runFailed: false, replyFinished: false });
    document.phone.mode = "never";
    expect((await put(app, document)).status).toBe(200);
    const patch = (body: unknown) => app.request("/api/coding-agents/notification-preferences", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await patch({ attentionPush: { approval: true } })).status).toBe(200);
    expect((await (await app.request(path)).json()).preferences).toEqual({ ...document, revision: 2,
      events: { ...document.events, approval: true } });
    for (const attentionPush of [{}, { approval: true, unknown: false }]) expect((await patch({ attentionPush })).status).toBe(400);
    expect((await (await app.request(path)).json()).preferences.revision).toBe(2);
  });
  it("makes legacy writes a projection preserving new options and invalidating stale new clients", async () => {
    const { app, legacy } = await fixture();
    const body = defaults(); body.phone.mode = "never"; body.content.showPreview = true; body.events.minReplySeconds = 300;
    expect((await put(app, body)).status).toBe(200);
    const oldBody = { attentionPush: { approval: false, input: false, failed: true, completed: false } };
    const oldSave = await put(app, oldBody, "/api/coding-agents/notification-preferences");
    expect(oldSave.status).toBe(200);
    expect(await oldSave.json()).toEqual({ preferences: oldBody });
    expect(await (await app.request("/api/coding-agents/notification-preferences")).json()).toEqual({ preferences: oldBody });
    const saved = (await (await app.request(path)).json()).preferences;
    expect(saved).toEqual({ ...body, revision: 2, events: { ...body.events, approval: false, question: false, replyFinished: false } });
    expect((await put(app, { ...body, revision: 1 })).status).toBe(409);
    expect(await legacy.isAttentionPushEnabled({ ownerId: principal.userId, kind: "approval" })).toBe(false);
    expect(await legacy.isAttentionPushEnabled({ ownerId: principal.userId, kind: "failed" })).toBe(true);
  });
  it("new event switches immediately govern the legacy bridge reader", async () => {
    const { app, legacy } = await fixture();
    const body = defaults();
    body.events = { approval: false, question: false, replyFinished: false, runFailed: false, minReplySeconds: 10 };
    expect((await put(app, body)).status).toBe(200);
    for (const kind of ["approval", "input", "completed", "failed"] as const) {
      expect(await legacy.isAttentionPushEnabled({ ownerId: principal.userId, kind })).toBe(false);
    }
  });
  it("refuses foreign principals on both APIs without modifying owner state", async () => {
    const { app, homePath, setPrincipal } = await fixture();
    await app.request(path);
    const before = await readFile(join(homePath, "system/notifications.json"), "utf8");
    setPrincipal({ userId: "other_user", source: "jwt" });
    for (const route of [path, "/api/coding-agents/notification-preferences"]) {
      expect((await app.request(route)).status).toBe(403);
      expect((await put(app, defaults(), route)).status).toBe(403);
    }
    expect(await readFile(join(homePath, "system/notifications.json"), "utf8")).toBe(before);
  });
  it("uses the authenticated principal and rejects missing identity", async () => {
    const { store } = await fixture();
    const app = new Hono();
    app.use("*", async (c, next) => { markAuthContextReady(c); await next(); });
    app.route("/api/notifications", createNotificationPreferenceRoutes({ store, principalConfig: {
      configuredUserId: undefined, isTrustedSingleUserGateway: false, authEnabled: true, isProduction: true, isLocalDevelopment: false,
    } }));
    expect((await app.request(path, { headers: { "x-platform-user-id": principal.userId } })).status).toBe(401);
  });
  it("rejects partial/extra documents, invalid JSON and oversized streamed bodies", async () => {
    const { app } = await fixture();
    for (const body of [{ revision: 0 }, { ...defaults(), content: { ...defaults().content, provider: "secret" } }]) {
      const res = await put(app, body); expect(res.status).toBe(400); expect((await res.json()).error.code).toBe("validation_failed");
    }
    expect((await app.request(path, { method: "PUT", body: "{" })).status).toBe(400);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(16_385))); controller.close(); } });
    const oversized = await app.request(new Request(`http://localhost${path}`, { method: "PUT", body: stream, duplex: "half" } as RequestInit));
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error.code).toBe("payload_too_large");
  });
  it.each(["new", "legacy", "invalid-schema"])("refuses corrupt %s state on read and write instead of re-enabling push", async (source) => {
    const { app, homePath, legacy } = await fixture();
    const file = source !== "legacy" ? join(homePath, "system/notifications.json") : join(homePath, "system/coding-agents/notification-preferences/owner_user.json");
    await mkdir(join(file, ".."), { recursive: true });
    const corrupt = source === "invalid-schema" ? JSON.stringify({ ...defaults(), content: { showPreview: "yes" } }) : "not JSON /home/matrix/private Bearer secret";
    await writeFile(file, corrupt);
    for (const response of [await app.request(path), await put(app, defaults()), await put(app, { attentionPush: { approval: true, input: true, failed: true } }, "/api/coding-agents/notification-preferences")]) {
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(/private|Bearer|secret/);
    }
    await expect(legacy.isAttentionPushEnabled({ ownerId: principal.userId, kind: "approval" })).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(corrupt);
  });
  it.each(["symlink", "oversized", "directory"])("refuses %s preference files", async (kind) => {
    const { app, homePath } = await fixture();
    await mkdir(join(homePath, "system"));
    const file = join(homePath, "system/notifications.json");
    if (kind === "symlink") { await writeFile(join(homePath, "foreign.json"), JSON.stringify(defaults())); await symlink(join(homePath, "foreign.json"), file); }
    else if (kind === "directory") await mkdir(file);
    else await writeFile(file, " ".repeat(16_385));
    expect((await app.request(path)).status).toBe(503);
    expect((await put(app, defaults())).status).toBe(503);
  });
});

import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@matrix-os/contracts";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createNotificationPreferenceRuntime } from "../../packages/gateway/src/notifications/runtime.js";
import { createReviewStore } from "../../packages/gateway/src/review-store.js";
import { registerGatewayCodingAgentRoutes } from "../../packages/gateway/src/server/project-routes.js";
import { registerFileRoutes } from "../../packages/gateway/src/server/file-routes.js";
import { createFilePreviewService } from "../../packages/gateway/src/file-preview-service.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { buildPlatformUserProof } from "../../packages/platform/src/session-routing-websocket.js";

const owner = "user_owner", viewer = "user_invited_viewer", handle = "pr-3519";
const secret = "notification-preview-platform-regression-secret";
const token = buildPlatformVerificationToken(handle, secret);
const canonical = "system/notifications.json";
const homes: string[] = [];
function headers(actor: string) {
  return { authorization: `Bearer ${token}`, "x-platform-user-id": actor,
    "x-platform-verified": buildPlatformUserProof(handle, actor, secret) };
}
beforeEach(() => {
  for (const [key, value] of Object.entries({ MATRIX_HANDLE: handle, MATRIX_RUNTIME_SLOT: handle,
    MATRIX_USER_ID: owner, MATRIX_CLERK_USER_ID: owner, PLATFORM_JWT_SECRET: "", PLATFORM_JWT_PUBLIC_KEY: "" })) vi.stubEnv(key, value);
});
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture(actor: string) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-notification-file-access-")); homes.push(homePath);
  const runtime = createNotificationPreferenceRuntime({ homePath, env: { MATRIX_USER_ID: owner }, reviewStore: createReviewStore({ homePath }) });
  const app = new Hono(); app.use("*", authMiddleware(token));
  app.get("/api/whoami", c => c.json(requireRequestPrincipal(c)));
  registerGatewayCodingAgentRoutes(app, { notificationPreferences: runtime.legacy,
    service: { getSummary: async () => { throw new Error("not used"); } },
    projects: { createProject: async () => { throw new Error("not used"); }, getProject: async () => { throw new Error("not used"); } } });
  registerFileRoutes(app, { homePath, getPrincipal: requireRequestPrincipal,
    getOwnerId: c => requireRequestPrincipal(c).userId,
    filePreviewService: createFilePreviewService({ homePath, canAccessHome: principal => principal.userId === owner,
      resolveProjectRoot: async () => null }) });
  expect((await app.request("/api/notifications/preferences", { headers: headers(owner) })).status).toBe(200);
  await writeFile(join(homePath, "system/public.txt"), "public neighbor");
  await symlink(homePath, join(homePath, "alias"));
  const request = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...headers(actor), ...init.headers } });
  expect(await (await request("/api/whoami")).json()).toEqual({ userId: actor, source: "platform-verified" });
  expect(await (await request("/files/system/public.txt")).text()).toBe("public neighbor");
  return { app, request, homePath, original: await readFile(join(homePath, canonical), "utf8") };
}

// Real platform proof -> gateway auth -> production file registrar/readers/writers -> actual owner file.
describe.each([owner, viewer])("notification configuration file isolation for %s", actor => {
  it("reserves content reads for the owner-checked notification API, including aliases and downloads", async () => {
    const { request } = await fixture(actor);
    for (const path of [canonical, `alias/${canonical}`]) {
      for (const url of [`/files/${path}`, `/api/files/blob?path=${path}`, `/api/files/media?path=${path}`,
        `/api/files/media?path=${path}&download=true`, `/api/files/stat?path=${path}`,
        `/api/file-previews/metadata?kind=home&path=${path}`, `/api/file-previews/content?kind=home&path=${path}`]) {
        const response = await request(url);
        expect(response.status, url).toBeGreaterThanOrEqual(400);
        expect(await response.text()).not.toContain("replyFinished");
      }
      expect((await request(`/files/${path}`, { method: "HEAD" })).status).toBeGreaterThanOrEqual(400);
      expect((await request(`/api/files/media?path=${path}`, { method: "HEAD" })).status).toBeGreaterThanOrEqual(400);
    }
    for (const directory of ["system", "alias/system"]) {
      const archive = await request(`/api/file-previews/directory?kind=home&path=${directory}`);
      expect(archive.status).toBeGreaterThanOrEqual(400);
      expect(await archive.text()).not.toContain("notifications.json");
    }
    expect((await request("/api/notifications/preferences")).status).toBe(actor === owner ? 200 : 403);
    expect((await request("/api/notifications/preferences", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(DEFAULT_NOTIFICATION_PREFERENCES) })).status).toBe(actor === owner ? 200 : 403);
    const legacyRead = await request("/api/coding-agents/notification-preferences");
    expect(legacyRead.status).toBe(actor === owner ? 200 : 403);
    const legacyPut = await request("/api/coding-agents/notification-preferences", { method: "PUT",
      headers: { "content-type": "application/json", "if-match": legacyRead.headers.get("etag") ?? '"0"' },
      body: JSON.stringify({ attentionPush: { approval: true, input: true, failed: true, completed: true } }) });
    expect(legacyPut.status).toBe(actor === owner ? 200 : 403);
    const ownerPatch = await request("/api/coding-agents/notification-preferences", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ attentionPush: { approval: false } }) });
    expect(ownerPatch.status).toBe(actor === owner ? 200 : 403);
    if (actor === owner) expect((await (await request("/api/notifications/preferences")).json()).preferences.events.approval).toBe(false);
  });

  it("cannot seed the reserved parent through destination-side moves, copies, or raw writes", async () => {
    const { request, homePath } = await fixture(actor);
    await rename(join(homePath, "system"), join(homePath, ".original-system"));
    await mkdir(join(homePath, "incoming"));
    await writeFile(join(homePath, "incoming/notifications.json"), "untrusted replacement");
    for (const operation of ["copy", "rename"]) {
      expect((await request(`/api/files/${operation}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "incoming", to: "system" }) })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await request("/files/system", { method: "PUT", body: "not a system directory" })).status).toBe(403);
    expect((await request("/api/files/blob?path=system", { method: "PUT", body: "not a system directory" })).status).toBeGreaterThanOrEqual(400);
    expect((await request("/api/files/touch", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "system", content: "not a system directory" }) })).status).toBeGreaterThanOrEqual(400);
    await expect(lstat(join(homePath, "system"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a historical parent-directory Trash entry recoverable without restoring protected preferences", async () => {
    const { request, homePath, original } = await fixture(actor);
    await rename(join(homePath, "system"), join(homePath, ".original-system"));
    await mkdir(join(homePath, ".trash/old-system"), { recursive: true });
    await writeFile(join(homePath, ".trash/old-system/notifications.json"), original);
    await writeFile(join(homePath, ".trash/.manifest.json"), JSON.stringify([{ name: "system", originalPath: "system",
      deletedAt: "2026-11-20T10:00:00Z", trashPath: ".trash/old-system" }]));
    const restored = await request("/api/files/trash/restore", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ trashPath: ".trash/old-system" }) });
    expect(restored.status).toBe(403);
    await expect(lstat(join(homePath, "system"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(homePath, ".trash/old-system/notifications.json"), "utf8")).toBe(original);
  });

  it("blocks raw replacements and destructive/recursive file mutations without changing the revision", async () => {
    const { request, homePath, original } = await fixture(actor);
    const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const attempts: Array<[string, RequestInit]> = [
      [`/files/${canonical}`, { method: "PUT", body: "{}" }],
      [`/api/files/blob?path=${canonical}&force=true`, { method: "PUT", body: "{}" }],
      ["/api/files/blob?path=system&filename=notifications.json&force=true", { method: "PUT", body: "{}" }],
      ["/api/files/touch", json({ path: canonical, content: "{}" })],
    ];
    for (const path of [canonical, "system", `alias/${canonical}`, "alias/system"]) {
      attempts.push(["/api/files/delete", json({ path })], ["/api/files/duplicate", json({ path })],
        ["/api/files/rename", json({ from: path, to: "exported" })], ["/api/files/copy", json({ from: path, to: "exported" })]);
    }
    for (const [url, init] of attempts) {
      expect((await request(url, init)).status, `${url} ${init.body}`).toBeGreaterThanOrEqual(400);
      expect(await readFile(join(homePath, canonical), "utf8")).toBe(original);
    }
    // Other owner-home files remain editable through the same authenticated route.
    expect((await request("/files/system/public.txt", { method: "PUT", body: "updated neighbor" })).status).toBe(200);
  });

  it("does not disclose preferences through listing/search or the legacy migration files", async () => {
    const { request, homePath } = await fixture(actor);
    const legacy = "system/coding-agents/notification-preferences";
    await mkdir(join(homePath, legacy), { recursive: true });
    await writeFile(join(homePath, legacy, `${owner}.json`), '{"attentionPush":{"approval":false}}');
    for (const prefix of ["system", "alias/system"]) {
      const listed = await (await request(`/api/files/list?path=${prefix}`)).json();
      expect(listed.entries.some((entry: { name: string }) => entry.name === "notifications.json")).toBe(false);
      const found = await (await request(`/api/files/search?path=${prefix}&q=replyFinished&content=true`)).json();
      expect(found.results).toEqual([]);
    }
    expect((await request(`/files/${legacy}/${owner}.json`)).status).toBeGreaterThanOrEqual(400);
    expect((await request(`/api/files/blob?path=${legacy}/${owner}.json&force=true`, { method: "PUT", body: "{}" })).status).toBeGreaterThanOrEqual(400);
  });
});

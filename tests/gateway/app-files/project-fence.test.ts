import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_FILES_BRIDGE_PATH, appFileVersion, encodeAppFileBase64 } from "../../../packages/contracts/src/app-files";
import * as appFileIo from "../../../packages/gateway/src/app-files/io";
import { createAppFileRoutes } from "../../../packages/gateway/src/app-files/routes";
import { registerBridgeFileRoutes } from "../../../packages/gateway/src/server/bridge-file-routes";
import { createHarness, errorCode, type AppFileHarness } from "./helpers";
import { createTestProjectAdmission, type TestProject, type TestProjectAdmission } from "./project-fence-helpers";

let harness: AppFileHarness | null = null;
afterEach(async () => { vi.restoreAllMocks(); await harness?.cleanup(); harness = null; });

const b64 = (text: string) => encodeAppFileBase64(new TextEncoder().encode(text));
const PROJECTS: readonly TestProject[] = [
  { id: "proj_shared", localPath: "projects/acme", ownerId: "owner", refusal: "scope_required" },
  { id: "proj_moving", localPath: "projects/moving", ownerId: "owner", refusal: "fenced" },
  { id: "proj_private", localPath: "projects/private", ownerId: "owner", refusal: null },
  { id: "proj_other", localPath: "projects/theirs", ownerId: "someone-else", refusal: "scope_required" },
];

async function fencedHost(projects = PROJECTS): Promise<{ post(input: unknown): Promise<Response>; home: string; fence: TestProjectAdmission }> {
  harness = await createHarness();
  const home = harness.home;
  for (const project of projects) await mkdir(join(home, project.localPath), { recursive: true });
  const fence = createTestProjectAdmission(home, projects);
  const host = new Hono();
  host.route(APP_FILES_BRIDGE_PATH, createAppFileRoutes({
    homePath: home, ownerIds: ["owner"], resolveOwner: () => "owner", projectPathAdmission: fence.admission,
  }));
  return {
    home, fence,
    post: (input) => host.request(APP_FILES_BRIDGE_PATH, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "docs", input }),
    }),
  };
}

async function versionOf(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return appFileVersion(info.size, info.mtimeNs);
}

// User outcome: a document saved from Docs or Sheets never changes a project
// that is shared or mid-transition behind the collaboration fence.
describe("app file writes and the collaboration project fence", () => {
  it("refuses to create a file inside a shared project and leaves the project untouched", async () => {
    const host = await fencedHost();
    const response = await host.post({ kind: "files.write", path: "projects/acme/contract.docx", contentBase64: b64("draft"), ifVersion: null });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
    expect(await readdir(join(host.home, "projects/acme"))).toEqual([]);
  });

  it("refuses to overwrite a file inside a shared project even with the current version", async () => {
    const host = await fencedHost();
    const target = join(host.home, "projects/acme/contract.docx");
    await writeFile(target, "shared copy");
    const response = await host.post({
      kind: "files.write", path: "projects/acme/contract.docx", contentBase64: b64("owner copy"), ifVersion: await versionOf(target),
    });
    expect(response.status).toBe(403);
    expect(await readFile(target, "utf8")).toBe("shared copy");
    expect(await readdir(join(host.home, "projects/acme"))).toEqual(["contract.docx"]);
  });

  it("refuses writes and new folders while a project transition holds the fence", async () => {
    const host = await fencedHost();
    const write = await host.post({ kind: "files.write", path: "projects/moving/notes/a.docx", contentBase64: b64("x"), ifVersion: null, createParents: true });
    const folder = await host.post({ kind: "files.mkdir", path: "projects/moving/drafts" });
    expect([write.status, folder.status]).toEqual([403, 403]);
    expect(await readdir(join(host.home, "projects/moving"))).toEqual([]);
  });

  it("refuses a new folder inside a shared project", async () => {
    const host = await fencedHost();
    const response = await host.post({ kind: "files.mkdir", path: "projects/acme/drafts" });
    expect(response.status).toBe(403);
    expect(await readdir(join(host.home, "projects/acme"))).toEqual([]);
  });

  it("holds the project admission for the whole write of an unshared project", async () => {
    const host = await fencedHost();
    let heldAtPublish = -1;
    const link = appFileIo.appFileIo.link;
    vi.spyOn(appFileIo.appFileIo, "link").mockImplementation(async (from, to) => {
      heldAtPublish = host.fence.held();
      return link(from, to);
    });
    const response = await host.post({ kind: "files.write", path: "projects/private/plan.docx", contentBase64: b64("plan"), ifVersion: null });
    expect(response.status).toBe(200);
    expect(heldAtPublish).toBe(1);
    expect(host.fence.events).toEqual(["enter:proj_private", "leave:proj_private"]);
    expect(await readFile(join(host.home, "projects/private/plan.docx"), "utf8")).toBe("plan");
  });

  it("keeps an operation failure inside an admitted project as its own error", async () => {
    const host = await fencedHost();
    await writeFile(join(host.home, "projects/private/plan.docx"), "current");
    const response = await host.post({ kind: "files.write", path: "projects/private/plan.docx", contentBase64: b64("stale"), ifVersion: "1-1" });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("version_conflict");
    expect(host.fence.held()).toBe(0);
  });

  it("writes outside every project, and inside another owner's project root, without asking the fence", async () => {
    const host = await fencedHost();
    await mkdir(join(host.home, "Documents"));
    const outside = await host.post({ kind: "files.write", path: "Documents/a.docx", contentBase64: b64("a"), ifVersion: null });
    const unrelated = await host.post({ kind: "files.write", path: "projects/theirs/a.docx", contentBase64: b64("a"), ifVersion: null });
    expect([outside.status, unrelated.status]).toEqual([200, 200]);
    expect(host.fence.events).toEqual([]);
  });

  it("still reads, lists and stats files of a shared project", async () => {
    const host = await fencedHost();
    await writeFile(join(host.home, "projects/acme/contract.docx"), "shared copy");
    const statuses = await Promise.all([
      host.post({ kind: "files.read", path: "projects/acme/contract.docx" }),
      host.post({ kind: "files.stat", path: "projects/acme/contract.docx" }),
      host.post({ kind: "files.list", dir: "projects/acme" }),
    ]);
    expect(statuses.map((response) => response.status)).toEqual([200, 200, 200]);
  });

  it("answers unavailable, and writes nothing, when the project inventory cannot be read", async () => {
    const host = await fencedHost();
    host.fence.failInventory = true;
    await mkdir(join(host.home, "Documents"));
    const response = await host.post({ kind: "files.write", path: "Documents/a.docx", contentBase64: b64("a"), ifVersion: null });
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("unavailable");
    expect(await readdir(join(host.home, "Documents"))).toEqual([]);
  });

  it("answers unavailable when the fence itself is over capacity", async () => {
    const host = await fencedHost([{ id: "proj_busy", localPath: "projects/busy", ownerId: "owner", refusal: "capacity" }]);
    const response = await host.post({ kind: "files.write", path: "projects/busy/a.docx", contentBase64: b64("a"), ifVersion: null });
    expect(response.status).toBe(503);
    expect(await readdir(join(host.home, "projects/busy"))).toEqual([]);
  });

  it("is applied by the gateway registration for the authenticated owner", async () => {
    harness = await createHarness();
    const home = harness.home;
    await mkdir(join(home, "projects/acme"), { recursive: true });
    const fence = createTestProjectAdmission(home, [{ id: "proj_shared", localPath: "projects/acme", ownerId: "owner", refusal: "scope_required" }]);
    const app = new Hono();
    app.use("*", async (context, next) => {
      context.set("authContextReady" as never, true as never);
      context.set("platformUserId" as never, "owner" as never);
      await next();
    });
    registerBridgeFileRoutes(app, {
      homePath: home, env: { MATRIX_USER_ID: "owner", NODE_ENV: "production" }, projectPathAdmission: fence.admission,
    });
    const post = (path: string) => app.request(APP_FILES_BRIDGE_PATH, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "docs", input: { kind: "files.write", path, contentBase64: b64("a"), ifVersion: null } }),
    });
    expect((await post("projects/acme/a.docx")).status).toBe(403);
    expect((await post("a.docx")).status).toBe(200);
    expect(await readdir(join(home, "projects/acme"))).toEqual([]);
  });

  // Fault: the guard only asked the fence about projects recorded under the
  // identity the request came in as, so a host that knows its owner by both
  // MATRIX_USER_ID and MATRIX_CLERK_USER_ID let one identity overwrite a
  // shared project recorded under the other.
  it.each([
    { caller: "owner", recordedUnder: "clerk-owner" },
    { caller: "clerk-owner", recordedUnder: "owner" },
  ])("refuses a $caller write into a shared project recorded under the owner's other identity ($recordedUnder)", async ({ caller, recordedUnder }) => {
    harness = await createHarness();
    const home = harness.home;
    await mkdir(join(home, "projects/acme"), { recursive: true });
    const target = join(home, "projects/acme/contract.docx");
    await writeFile(target, "shared copy");
    const fence = createTestProjectAdmission(home, [{ id: "proj_shared", localPath: "projects/acme", ownerId: recordedUnder, refusal: "scope_required" }]);
    const app = new Hono();
    app.use("*", async (context, next) => {
      context.set("authContextReady" as never, true as never);
      context.set("platformUserId" as never, caller as never);
      await next();
    });
    registerBridgeFileRoutes(app, {
      homePath: home,
      env: { MATRIX_USER_ID: "owner", MATRIX_CLERK_USER_ID: "clerk-owner", NODE_ENV: "production" },
      projectPathAdmission: fence.admission,
    });
    const post = (input: unknown) => app.request(APP_FILES_BRIDGE_PATH, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "docs", input }),
    });
    const write = await post({ kind: "files.write", path: "projects/acme/contract.docx", contentBase64: b64("owner copy"), ifVersion: await versionOf(target) });
    const folder = await post({ kind: "files.mkdir", path: "projects/acme/drafts" });
    expect([write.status, folder.status]).toEqual([403, 403]);
    expect(await readFile(target, "utf8")).toBe("shared copy");
    expect(await readdir(join(home, "projects/acme"))).toEqual(["contract.docx"]);
  });

  it("admits a write into an unshared project only after every owner identity's projects admit it", async () => {
    harness = await createHarness();
    const home = harness.home;
    await mkdir(join(home, "projects/private"), { recursive: true });
    const fence = createTestProjectAdmission(home, [
      { id: "proj_user", localPath: "projects/private", ownerId: "owner", refusal: null },
      { id: "proj_clerk", localPath: "projects/private", ownerId: "clerk-owner", refusal: null },
    ]);
    const host = new Hono();
    host.route(APP_FILES_BRIDGE_PATH, createAppFileRoutes({
      homePath: home, ownerIds: ["owner", "clerk-owner"], resolveOwner: () => "clerk-owner", projectPathAdmission: fence.admission,
    }));
    const response = await host.request(APP_FILES_BRIDGE_PATH, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "docs", input: { kind: "files.write", path: "projects/private/plan.docx", contentBase64: b64("plan"), ifVersion: null } }),
    });
    expect(response.status).toBe(200);
    expect(fence.events).toEqual(["enter:proj_user", "enter:proj_clerk", "leave:proj_clerk", "leave:proj_user"]);
    expect(fence.held()).toBe(0);
  });
});

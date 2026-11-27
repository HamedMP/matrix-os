import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Hono } from "hono";
import { APP_FILES_BRIDGE_PATH, encodeAppFileBase64 } from "../../../packages/contracts/src/app-files";
import { ProjectFenceError } from "../../../packages/gateway/src/collaboration/project-fence";
import { registerBridgeFileRoutes } from "../../../packages/gateway/src/server/bridge-file-routes";
import { createGatewayAppFileProjectPathAdmission } from "../../../packages/gateway/src/server/project-routes";
import { listAppFiles, readAppFile } from "../../../packages/gateway/src/app-files/read-ops";
import { mkdirAppFile, writeAppFile } from "../../../packages/gateway/src/app-files/write-ops";
import { createHarness, errorCode, type AppFileHarness } from "./helpers";

/** Records synchronous path checks so a test can prove a request never blocks on them. */
const syncFsCalls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const recorded = <T extends (...args: never[]) => unknown>(name: string, fn: T) => ((...args: Parameters<T>) => {
    syncFsCalls.push(`${name}:${String(args[0])}`);
    return fn(...args);
  }) as T;
  const realpathSync = Object.assign(recorded("realpathSync", actual.realpathSync), { native: actual.realpathSync.native });
  const fs = { ...actual, existsSync: recorded("existsSync", actual.existsSync), lstatSync: recorded("lstatSync", actual.lstatSync), statSync: recorded("statSync", actual.statSync), realpathSync };
  return { ...fs, default: fs };
});

let harness: AppFileHarness | null = null;
afterEach(async () => { await harness?.cleanup(); harness = null; });

const bytes = encodeAppFileBase64(new TextEncoder().encode("payload"));
async function code(response: Response): Promise<[number, string]> {
  return [response.status, response.status === 200 ? "ok" : await errorCode(response)];
}

describe("app file path security", () => {
  it.each(["system/app-capabilities.json", ".ssh/id_ed25519", "agents/custom.md", ".hermes/state.json"])(
    "refuses to read, stat or list the protected path %s",
    async (path) => {
      harness = await createHarness();
      await mkdir(join(harness.home, path, ".."), { recursive: true });
      await writeFile(join(harness.home, path), "secret");
      expect(await code(await harness.post({ kind: "files.read", path }))).toEqual([403, "forbidden"]);
      expect(await code(await harness.post({ kind: "files.stat", path }))).toEqual([403, "forbidden"]);
      expect(await code(await harness.post({ kind: "files.list", dir: path.split("/")[0] }))).toEqual([403, "forbidden"]);
    },
  );

  it.each(["system/evil.txt", ".bashrc", "agents/x/y.md", ".trash/f.txt"])("refuses to write or mkdir the protected path %s", async (path) => {
    harness = await createHarness();
    expect(await code(await harness.post({ kind: "files.write", path, contentBase64: bytes, ifVersion: null, createParents: true }))).toEqual([403, "forbidden"]);
    expect(await code(await harness.post({ kind: "files.mkdir", path }))).toEqual([403, "forbidden"]);
    await expect(lstat(join(harness.home, path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hides the denied data subtrees as not found", async () => {
    harness = await createHarness();
    await mkdir(join(harness.home, "data/browser-profiles/p1"), { recursive: true });
    await writeFile(join(harness.home, "data/browser-profiles/p1/cookies"), "c");
    expect(await code(await harness.post({ kind: "files.read", path: "data/browser-profiles/p1/cookies" }))).toEqual([404, "not_found"]);
    expect(await code(await harness.post({ kind: "files.list", dir: "data/browser-profiles" }))).toEqual([404, "not_found"]);
    expect(await code(await harness.post({ kind: "files.write", path: "data/browser-profiles/p1/new", contentBase64: bytes, ifVersion: null }))).toEqual([404, "not_found"]);
    const listing = await (await harness.post({ kind: "files.list", dir: "data" })).json();
    expect(listing.entries).toEqual([]);
  });

  it("rejects traversal and malformed paths at the schema", async () => {
    harness = await createHarness();
    for (const path of ["../outside.txt", "a/../../outside.txt", "./a", "a//b", "a/", "a\\b", "a\u0000b"]) {
      expect(await code(await harness.post({ kind: "files.read", path }))).toEqual([400, "invalid_request"]);
      expect(await code(await harness.post({ kind: "files.write", path, contentBase64: bytes, ifVersion: null }))).toEqual([400, "invalid_request"]);
    }
  });

  it("refuses a symlinked file for every operation and never writes through it", async () => {
    harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "app-files-outside-"));
    onTestFinished(() => rm(outsideDir, { recursive: true, force: true }));
    const outside = join(outsideDir, "outside.txt");
    await writeFile(outside, "outside");
    await writeFile(join(harness.home, "inside.txt"), "inside");
    await symlink(outside, join(harness.home, "out-link.txt"));
    await symlink(join(harness.home, "inside.txt"), join(harness.home, "in-link.txt"));
    for (const path of ["out-link.txt", "in-link.txt"]) {
      expect(await code(await harness.post({ kind: "files.read", path }))).toEqual([403, "forbidden"]);
      expect(await code(await harness.post({ kind: "files.stat", path }))).toEqual([403, "forbidden"]);
      expect((await harness.post({ kind: "files.write", path, contentBase64: bytes, ifVersion: null })).status).toBe(403);
    }
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect(await readFile(join(harness.home, "inside.txt"), "utf8")).toBe("inside");
    expect((await lstat(join(harness.home, "out-link.txt"))).isSymbolicLink()).toBe(true);
  });

  it("refuses a path through a symlinked directory, even one that stays inside home", async () => {
    harness = await createHarness();
    await writeFile(join(harness.home, "system/secret.json"), "{}");
    await symlink(join(harness.home, "system"), join(harness.home, "sys-alias"));
    await mkdir(join(harness.home, "real"));
    await writeFile(join(harness.home, "real/a.txt"), "a");
    await symlink(join(harness.home, "real"), join(harness.home, "alias"));
    expect((await harness.post({ kind: "files.read", path: "sys-alias/secret.json" })).status).toBe(403);
    expect((await harness.post({ kind: "files.read", path: "alias/a.txt" })).status).toBe(403);
    expect((await harness.post({ kind: "files.list", dir: "alias" })).status).toBe(403);
    expect((await harness.post({ kind: "files.write", path: "alias/b.txt", contentBase64: bytes, ifVersion: null })).status).toBe(403);
    expect((await harness.post({ kind: "files.mkdir", path: "alias/sub" })).status).toBe(403);
    await expect(lstat(join(harness.home, "real/b.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("omits symlinks and protected entries from listings", async () => {
    harness = await createHarness();
    await writeFile(join(harness.home, "visible.txt"), "v");
    await writeFile(join(harness.home, ".hidden"), "h");
    await symlink(join(harness.home, "visible.txt"), join(harness.home, "link.txt"));
    const listing = await (await harness.post({ kind: "files.list", dir: "" })).json();
    const names = listing.entries.map((entry: { name: string }) => entry.name);
    expect(names).toContain("visible.txt");
    expect(names).toContain("apps");
    for (const hidden of ["system", ".hidden", "link.txt"]) expect(names).not.toContain(hidden);
  });

  it("resolves request paths without synchronous filesystem calls", async () => {
    harness = await createHarness();
    await mkdir(join(harness.home, "Documents"));
    await writeFile(join(harness.home, "Documents/plan.docx"), "plan");
    syncFsCalls.length = 0;
    const responses = await Promise.all([
      harness.post({ kind: "files.stat", path: "Documents/plan.docx" }),
      harness.post({ kind: "files.read", path: "Documents/plan.docx" }),
      harness.post({ kind: "files.list", dir: "Documents" }),
      harness.post({ kind: "files.write", path: "Documents/new.docx", contentBase64: bytes, ifVersion: null }),
      harness.post({ kind: "files.mkdir", path: "Documents/sub" }),
      harness.post({ kind: "files.read", path: "Documents/missing.docx" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 404]);
    const home = harness.home;
    expect(syncFsCalls.filter((call) => call.includes(home) && !call.includes(`${home}/apps`))).toEqual([]);
  });

  // Fault: with collaboration enabled the write fence matched paths with the
  // synchronous File API resolver, so every app save and folder creation
  // blocked the gateway on disk checks while the fence was consulted.
  it("fences writes into collaboration projects without synchronous filesystem calls", async () => {
    harness = await createHarness();
    const home = harness.home;
    await mkdir(join(home, "projects/private"), { recursive: true });
    await mkdir(join(home, "projects/acme"), { recursive: true });
    const entered: string[] = [];
    const admission = createGatewayAppFileProjectPathAdmission({
      homePath: home,
      projects: {
        listManagedProjects: async () => ({
          projects: [{ id: "proj_private", localPath: "projects/private" }, { id: "proj_shared", localPath: "projects/acme" }],
        }),
      } as never,
      projectOperationAdmission: {
        async withLegacyAdmission(input, operation) {
          if (input.projectId === "proj_shared") throw new ProjectFenceError("scope_required");
          entered.push(input.projectId);
          return operation();
        },
      },
    });
    const app = new Hono();
    app.use("*", async (context, next) => {
      context.set("authContextReady" as never, true as never);
      context.set("platformUserId" as never, "owner" as never);
      await next();
    });
    registerBridgeFileRoutes(app, { homePath: home, env: { MATRIX_USER_ID: "owner", NODE_ENV: "production" }, ...(admission ? { projectPathAdmission: admission } : {}) });
    const post = (input: unknown) => app.request(APP_FILES_BRIDGE_PATH, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "docs", input }),
    });
    syncFsCalls.length = 0;
    const responses = await Promise.all([
      post({ kind: "files.write", path: "projects/private/plan.docx", contentBase64: bytes, ifVersion: null }),
      post({ kind: "files.mkdir", path: "projects/private/drafts" }),
      post({ kind: "files.write", path: "projects/acme/plan.docx", contentBase64: bytes, ifVersion: null }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 403]);
    expect(entered).toEqual(["proj_private", "proj_private"]);
    expect(syncFsCalls.filter((call) => call.includes(home) && !call.includes(`${home}/apps`))).toEqual([]);
  });

  // Fault: with the configured home reached through a link, folder projects
  // record their real root while the fence matched the home's spelling, so a
  // save into a shared folder project skipped the fence and was written.
  it("fences a home reached through a link as it fences the unlinked home", async () => {
    harness = await createHarness();
    const realHome = harness.home;
    const outsideDir = await mkdtemp(join(tmpdir(), "app-files-outside-"));
    onTestFinished(() => rm(outsideDir, { recursive: true, force: true }));
    const linkedHome = join(outsideDir, "home-link");
    await symlink(realHome, linkedHome);
    await mkdir(join(realHome, "Documents"));
    await mkdir(join(realHome, "projects/acme"), { recursive: true });
    await mkdir(join(realHome, "projects/private"), { recursive: true });
    const hostFor = (homePath: string) => {
      const entered: string[] = [];
      const projects = [
        // A folder project records its real root; a scratch project its root under the configured home.
        { id: "proj_folder", localPath: join(realHome, "Documents") },
        { id: "proj_scratch", localPath: join(homePath, "projects/acme") },
        { id: "proj_private", localPath: join(homePath, "projects/private") },
      ];
      const admission = createGatewayAppFileProjectPathAdmission({
        homePath,
        projects: { listManagedProjects: async () => ({ projects }) } as never,
        projectOperationAdmission: {
          async withLegacyAdmission(input, operation) {
            if (input.projectId !== "proj_private") throw new ProjectFenceError("scope_required");
            entered.push(input.projectId);
            return operation();
          },
        },
      });
      const app = new Hono();
      app.use("*", async (context, next) => {
        context.set("authContextReady" as never, true as never);
        context.set("platformUserId" as never, "owner" as never);
        await next();
      });
      registerBridgeFileRoutes(app, { homePath, env: { MATRIX_USER_ID: "owner", NODE_ENV: "production" }, ...(admission ? { projectPathAdmission: admission } : {}) });
      return {
        entered,
        post: (input: unknown) => app.request(APP_FILES_BRIDGE_PATH, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "docs", input }),
        }),
      };
    };
    for (const homePath of [realHome, linkedHome]) {
      const host = hostFor(homePath);
      syncFsCalls.length = 0;
      const responses = await Promise.all([
        host.post({ kind: "files.write", path: "Documents/plan.docx", contentBase64: bytes, ifVersion: null }),
        host.post({ kind: "files.mkdir", path: "Documents/drafts" }),
        host.post({ kind: "files.write", path: "projects/acme/plan.docx", contentBase64: bytes, ifVersion: null }),
        host.post({ kind: "files.write", path: "projects/private/plan.docx", contentBase64: bytes, ifVersion: null }),
      ]);
      expect(responses.map((response) => response.status), homePath).toEqual([403, 403, 403, 200]);
      expect(host.entered, homePath).toEqual(["proj_private"]);
      expect(syncFsCalls.filter((call) => call.includes(realHome) || call.includes(linkedHome)), homePath).toEqual([]);
      await rm(join(realHome, "projects/private/plan.docx"));
    }
    await expect(lstat(join(realHome, "Documents/plan.docx"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(realHome, "Documents/drafts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(realHome, "projects/acme/plan.docx"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Fault: a home whose real location cannot be resolved must not leave the
  // write unfenced; it is refused before anything is written.
  it("refuses a fenced write when the home's real location cannot be resolved", async () => {
    harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "app-files-outside-"));
    onTestFinished(() => rm(outsideDir, { recursive: true, force: true }));
    const danglingHome = join(outsideDir, "gone-home");
    await symlink(join(outsideDir, "missing"), danglingHome);
    const operation = vi.fn(async () => "ran");
    const admission = createGatewayAppFileProjectPathAdmission({
      homePath: danglingHome,
      projects: { listManagedProjects: async () => ({ projects: [] }) } as never,
      projectOperationAdmission: { withLegacyAdmission: async (_input, next) => next() },
    });
    await expect(admission?.withPaths({ ownerType: "personal", ownerId: "owner", paths: ["Documents/a.docx"], kind: "write" }, operation))
      .rejects.toBeInstanceOf(ProjectFenceError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("serves a home that is itself reached through a link", async () => {
    harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "app-files-outside-"));
    onTestFinished(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(join(outsideDir, "a.txt"), "outside");
    // The home itself is reached through a link: real paths are compared, not spellings.
    const linkedHome = join(outsideDir, "home-link");
    await symlink(harness.home, linkedHome);
    const linked = await createHarness({ homePath: linkedHome, install: false });
    onTestFinished(() => linked.cleanup());
    await writeFile(join(harness.home, "inside.txt"), "inside");
    expect(await code(await linked.post({ kind: "files.read", path: "inside.txt" }))).toEqual([200, "ok"]);
  });

  // Fault: with the configured home itself a link, the home root was checked
  // with lstat, which describes the link, so listing the root and saving a
  // file directly under it were refused instead of served.
  it("serves the root of a home reached through a link and still refuses links inside it", async () => {
    harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "app-files-outside-"));
    onTestFinished(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(join(outsideDir, "secret.txt"), "outside");
    const linkedHome = join(outsideDir, "home-link");
    await symlink(harness.home, linkedHome);
    const linked = await createHarness({ homePath: linkedHome, install: false });
    onTestFinished(() => linked.cleanup());
    await mkdir(join(harness.home, "Documents"));
    await writeFile(join(harness.home, "report.docx"), "report");
    await symlink(join(outsideDir, "secret.txt"), join(harness.home, "out-link.txt"));
    await symlink(outsideDir, join(harness.home, "out-dir"));

    const listed = await linked.post({ kind: "files.list", dir: "" });
    expect(listed.status).toBe(200);
    const names = ((await listed.json()) as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["Documents", "report.docx"]));
    expect(names).not.toContain("out-link.txt");
    expect(names).not.toContain("out-dir");

    const stat = await linked.post({ kind: "files.stat", path: "report.docx" });
    expect(stat.status).toBe(200);
    const { version } = (await stat.json()) as { version: string };
    expect(await code(await linked.post({ kind: "files.read", path: "report.docx" }))).toEqual([200, "ok"]);
    expect(await code(await linked.post({ kind: "files.write", path: "report.docx", contentBase64: bytes, ifVersion: version }))).toEqual([200, "ok"]);
    expect(await code(await linked.post({ kind: "files.write", path: "new.docx", contentBase64: bytes, ifVersion: null }))).toEqual([200, "ok"]);
    expect(await code(await linked.post({ kind: "files.mkdir", path: "Drafts" }))).toEqual([200, "ok"]);
    expect(await code(await linked.post({ kind: "files.list", dir: "Documents" }))).toEqual([200, "ok"]);
    expect(await readFile(join(harness.home, "report.docx"), "utf8")).toBe("payload");
    expect(await readFile(join(harness.home, "new.docx"), "utf8")).toBe("payload");
    expect((await lstat(join(harness.home, "Drafts"))).isDirectory()).toBe(true);

    expect(await code(await linked.post({ kind: "files.read", path: "out-link.txt" }))).toEqual([403, "forbidden"]);
    expect(await code(await linked.post({ kind: "files.stat", path: "out-link.txt" }))).toEqual([403, "forbidden"]);
    expect(await code(await linked.post({ kind: "files.list", dir: "out-dir" }))).toEqual([403, "forbidden"]);
    expect(await code(await linked.post({ kind: "files.write", path: "out-link.txt", contentBase64: bytes, ifVersion: null }))).toEqual([403, "forbidden"]);
    expect(await code(await linked.post({ kind: "files.write", path: "out-dir/a.txt", contentBase64: bytes, ifVersion: null }))).toEqual([403, "forbidden"]);
    expect(await code(await linked.post({ kind: "files.mkdir", path: "out-dir/sub" }))).toEqual([403, "forbidden"]);
    expect(await readFile(join(outsideDir, "secret.txt"), "utf8")).toBe("outside");
    await expect(lstat(join(outsideDir, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(outsideDir, "sub"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Fault: a configured home whose link leads nowhere is a misconfigured
  // server, not a missing folder, so it must not answer not_found.
  it("answers unavailable when the configured home cannot be resolved", async () => {
    harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "app-files-outside-"));
    onTestFinished(() => rm(outsideDir, { recursive: true, force: true }));
    const danglingHome = join(outsideDir, "gone-home");
    await symlink(join(outsideDir, "missing"), danglingHome);
    const unavailable = { code: "unavailable" };
    await expect(listAppFiles(danglingHome, "", 10)).rejects.toMatchObject(unavailable);
    await expect(readAppFile(danglingHome, "a.docx")).rejects.toMatchObject(unavailable);
    await expect(writeAppFile(danglingHome, { path: "a.docx", contentBase64: bytes, ifVersion: null })).rejects.toMatchObject(unavailable);
    await expect(mkdirAppFile(danglingHome, "Drafts")).rejects.toMatchObject(unavailable);
    await expect(lstat(join(outsideDir, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replies not_found for missing paths and missing parents", async () => {
    harness = await createHarness();
    expect(await code(await harness.post({ kind: "files.read", path: "nope.docx" }))).toEqual([404, "not_found"]);
    expect(await code(await harness.post({ kind: "files.list", dir: "nope" }))).toEqual([404, "not_found"]);
    expect(await code(await harness.post({ kind: "files.write", path: "nope/a.docx", contentBase64: bytes, ifVersion: null }))).toEqual([404, "not_found"]);
  });
});

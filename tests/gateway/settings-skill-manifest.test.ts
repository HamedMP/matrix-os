import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PROJECT_SKILL_FILE_MAX_BYTES } from "@matrix-os/contracts";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createSettingsRoutes } from "../../packages/gateway/src/routes/settings.js";

const token = "fixture-owner-token";
const bundledDirectory = fileURLToPath(new URL("../../skills/matrix/animation-accessibility", import.meta.url));
const manifest = "---\r\nname: owner-skill\r\ndescription: Prepare a review.\r\n---\r\n\r\n# Review instructions\r\n";
let homePath: string;
let app: Hono;

beforeEach(async () => {
  homePath = await realpath(await mkdtemp(join(tmpdir(), "matrix-settings-skill-")));
  app = new Hono();
  app.use("*", authMiddleware(token));
  app.route("/api/settings", createSettingsRoutes({ homePath, channelManager: {} as never }));
});
afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });

function request(path: string, authenticated = true) {
  return app.request(`/api/settings/skills/manifest?path=${encodeURIComponent(path)}`, {
    headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function write(path: string, content: string | Buffer = manifest) {
  const destination = join(homePath, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

it("serves only authenticated installed manifests, including a packaged directory symlink", async () => {
  const installed = ".agents/skills/matrix-animation-accessibility/SKILL.md";
  await mkdir(join(homePath, ".agents/skills"), { recursive: true });
  await symlink(bundledDirectory, join(homePath, dirname(installed)), "dir");
  const catalogue = await app.request("/api/settings/skills", { headers: { Authorization: `Bearer ${token}` } });
  expect(await catalogue.json()).toEqual(expect.arrayContaining([expect.objectContaining({ file: installed })]));
  expect((await request(installed, false)).status).toBe(401);
  const response = await request(installed);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(join(bundledDirectory, "SKILL.md")));
});

it("keeps ordinary, mirrored and legacy installed file contents unchanged", async () => {
  const regular = ".agents/skills/owner-skill/SKILL.md";
  const mirror = ".claude/skills/owner-skill/SKILL.md";
  const legacy = "agents/skills/owner-skill.md";
  await write(regular);
  await write(legacy);
  await mkdir(join(homePath, dirname(dirname(mirror))), { recursive: true });
  await symlink(join(homePath, dirname(regular)), join(homePath, dirname(mirror)), "dir");
  for (const path of [regular, mirror, legacy]) {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(manifest);
  }
});

it("rejects project paths, redirected skill roots and linked files outside approved roots", async () => {
  const project = "projects/project-b/.agents/skills/owner-skill/SKILL.md";
  const installed = ".agents/skills/owner-skill/SKILL.md";
  const linkedFile = ".agents/skills/linked-file/SKILL.md";
  const hardlinkedFile = "agents/skills/hardlinked-file.md";
  const nested = ".agents/skills/owner-directory/scripts/nested/SKILL.md";
  const nestedLink = ".agents/skills/nested-link/SKILL.md";
  await write(project, manifest + "private project marker");
  await write(nested, manifest + "private project marker");
  await mkdir(join(homePath, ".agents/skills"), { recursive: true });
  await mkdir(join(homePath, dirname(linkedFile)), { recursive: true });
  await mkdir(join(homePath, dirname(hardlinkedFile)), { recursive: true });
  await symlink(join(homePath, dirname(project)), join(homePath, dirname(installed)), "dir");
  await symlink(join(homePath, dirname(nested)), join(homePath, dirname(nestedLink)), "dir");
  await symlink(join(homePath, project), join(homePath, linkedFile), "file");
  await link(join(homePath, project), join(homePath, hardlinkedFile));
  await mkdir(join(homePath, ".claude"), { recursive: true });
  await symlink(join(homePath, "projects/project-b/.agents/skills"), join(homePath, ".claude/skills"), "dir");
  expect((await request(project)).status).toBe(400);
  for (const path of [installed, linkedFile, hardlinkedFile, nestedLink, ".claude/skills/owner-skill/SKILL.md"]) {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("private project marker");
  }
});

it("rejects invalid UTF-8 and caps the manifest by bytes", async () => {
  const path = ".agents/skills/owner-skill/SKILL.md";
  const available = PROJECT_SKILL_FILE_MAX_BYTES - Buffer.byteLength(manifest);
  const exact = manifest + "é".repeat(Math.floor(available / 2)) + "a".repeat(available % 2);
  await write(path, exact);
  expect(await (await request(path)).text()).toBe(exact);
  await write(path, exact + "a");
  expect((await request(path)).status).toBe(404);
  await write(path, Buffer.concat([Buffer.from(manifest), Buffer.from([0xff])]));
  expect((await request(path)).status).toBe(404);
});

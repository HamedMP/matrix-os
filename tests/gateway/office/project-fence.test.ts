import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectFenceError } from "../../../packages/gateway/src/collaboration/project-fence";
import { createGatewayOfficeDocuments } from "../../../packages/gateway/src/office/gateway-wiring";
import { officeFenceOwnerIds } from "../../../packages/gateway/src/office/routes";
import { createGatewayProjectPathAdmission } from "../../../packages/gateway/src/server/project-routes";
import { createTestProjectAdmission, type TestProject } from "../app-files/project-fence-helpers";
import { createOfficeHarness, json, type OfficeHarness } from "./helpers";

let harness: OfficeHarness | null = null;
afterEach(async () => { vi.unstubAllEnvs(); await harness?.cleanup(); harness = null; });

const PROJECTS: readonly TestProject[] = [
  { id: "proj_shared", localPath: "projects/acme", ownerId: "owner", refusal: "scope_required" },
  { id: "proj_moving", localPath: "projects/moving", ownerId: "legacy-owner", refusal: "fenced" },
  { id: "proj_private", localPath: "projects/private", ownerId: "owner", refusal: null },
];

async function fenced(ownerIds: readonly string[] = ["owner", "legacy-owner"]) {
  // The harness makes the home; the fence needs it, so it is attached through a holder.
  const holder: { fence?: ReturnType<typeof createTestProjectAdmission> } = {};
  harness = await createOfficeHarness({
    projectPathAdmission: {
      withPaths: (input, operation) => holder.fence!.admission.withPaths(input, operation),
      withStoredPaths: (input, operation) => holder.fence!.admission.withStoredPaths(input, operation),
    },
    ownerIds,
  });
  holder.fence = createTestProjectAdmission(harness.home, PROJECTS);
  for (const project of PROJECTS) await mkdir(join(harness.home, project.localPath), { recursive: true });
  return { h: harness, fence: holder.fence };
}

// User outcome: an agent edit or a new agent document never changes a project
// that is shared or mid-transition behind the collaboration fence.
describe("document service saves and the collaboration project fence", () => {
  it("refuses a tracked edit to a document inside a shared project and leaves the bytes alone", async () => {
    const { h } = await fenced();
    const path = await h.copyFixture("basic.docx", "projects/acme/contract.docx");
    const before = await h.bytes(path);
    const response = await h.post("/documents/propose-edits", {
      path, author: "Agent", edits: [{ op: "replaceText", blockId: "b3", find: "three priorities", replace: "four priorities" }],
    });
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ error: "forbidden" });
    expect(await h.bytes(path)).toEqual(before);
    expect(await readdir(join(h.home, "projects/acme"))).toEqual(["contract.docx"]);
  });

  it("refuses to create or compare into a shared project", async () => {
    const { h } = await fenced();
    const a = await h.copyFixture("basic.docx", "docs/a.docx");
    const b = await h.copyFixture("basic.docx", "docs/b.docx");
    const created = await h.post("/documents/create", { path: "projects/acme/new.docx", paragraphs: ["One"] });
    const compared = await h.post("/documents/compare", { originalPath: a, revisedPath: b, outputPath: "projects/acme/diff.docx", author: "Agent" });
    expect([created.status, compared.status]).toEqual([403, 403]);
    expect(await readdir(join(h.home, "projects/acme"))).toEqual([]);
  });

  it("refuses sheet edits while a transition holds the fence under any identity of the owner", async () => {
    const { h } = await fenced();
    const path = await h.copyFixture("basic.xlsx", "projects/moving/book.xlsx");
    const before = await h.bytes(path);
    const sheet = (await json<{ sheet: string }>(await h.post("/sheets/describe", { path }))).sheet;
    const response = await h.post("/sheets/propose-edits", {
      path, author: "Agent", label: "set", edits: [{ op: "setCell", sheet, cell: "Z9", value: 5 }],
    });
    expect(response.status).toBe(403);
    expect(await h.bytes(path)).toEqual(before);
  });

  it("still reads documents of a shared project", async () => {
    const { h } = await fenced();
    const path = await h.copyFixture("basic.docx", "projects/acme/contract.docx");
    expect((await h.post("/documents/describe", { path })).status).toBe(200);
    expect((await h.post("/documents/revisions/list", { path })).status).toBe(200);
  });

  it("saves inside an unshared project while holding its admission, and outside projects without asking", async () => {
    const { h, fence } = await fenced();
    const created = await h.post("/documents/create", { path: "projects/private/new.docx", paragraphs: ["One"] });
    expect(created.status).toBe(200);
    expect(fence.events).toEqual(["enter:proj_private", "leave:proj_private"]);
    const outside = await h.post("/documents/create", { path: "docs/new.docx", paragraphs: ["One"] });
    expect(outside.status).toBe(200);
    expect(fence.events).toHaveLength(2);
    expect(fence.held()).toBe(0);
  });

  it("answers unavailable, and writes nothing, when the fence cannot be consulted", async () => {
    const { h, fence } = await fenced();
    fence.failInventory = true;
    const response = await h.post("/documents/create", { path: "docs/new.docx", paragraphs: ["One"] });
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({ error: "unavailable" });
    expect(await readdir(join(h.home, "docs"))).toEqual([]);
  });

  it("fails closed when a fence is configured but the gateway has no owner identity", async () => {
    const { h } = await fenced([]);
    const response = await h.post("/documents/create", { path: "docs/new.docx", paragraphs: ["One"] });
    expect(response.status).toBe(503);
    expect(await readdir(join(h.home, "docs"))).toEqual([]);
  });
});

describe("gateway wiring of the project fence", () => {
  it("asks the fence for the VPS owner under both of its identities", () => {
    expect(officeFenceOwnerIds({ MATRIX_USER_ID: "user_1", MATRIX_CLERK_USER_ID: "clerk_1", NODE_ENV: "production" })).toEqual(["user_1", "clerk_1"]);
    expect(officeFenceOwnerIds({ MATRIX_CLERK_USER_ID: "clerk_1", NODE_ENV: "production" })).toEqual(["clerk_1"]);
    expect(officeFenceOwnerIds({ MATRIX_USER_ID: "same", MATRIX_CLERK_USER_ID: "same" })).toEqual(["same"]);
  });

  it("uses the development principal only on an unauthenticated local gateway", () => {
    expect(officeFenceOwnerIds({ NODE_ENV: "development" })).toEqual(["default"]);
    expect(officeFenceOwnerIds({ NODE_ENV: "development", MATRIX_AUTH_TOKEN: "token" })).toEqual([]);
    expect(officeFenceOwnerIds({ NODE_ENV: "production" })).toEqual([]);
  });

  it("builds no fence without a collaboration database and one fence with it", async () => {
    harness = await createOfficeHarness();
    const homePath = harness.home;
    const projects = { listManagedProjects: async () => ({ projects: [{ id: "proj_a", localPath: "projects/a" }] }) };
    expect(createGatewayProjectPathAdmission({ homePath, projects: projects as never })).toBeUndefined();
    const entered: string[] = [];
    const admission = createGatewayProjectPathAdmission({
      homePath, projects: projects as never,
      projectOperationAdmission: {
        withLegacyAdmission: async (input, operation) => { entered.push(`${input.ownerId}:${input.projectId}:${input.kind}`); return operation(); },
      },
    });
    await admission?.withPaths({ ownerType: "personal", ownerId: "owner", paths: ["projects/a/x.docx"], kind: "write" }, async () => undefined);
    expect(entered).toEqual(["owner:proj_a:write"]);
  });

  it("hands the same fence to the document service and the app file bridge at startup", async () => {
    const server = await readFile("packages/gateway/src/server.ts", "utf8");
    expect(server).toContain("const officeDocuments = createGatewayOfficeDocuments({ homePath, projects: codingAgentProjectManager, projectOperationAdmission: gatewayCollaboration?.projectOperationAdmission });");
    expect(server).toContain("documentTools: officeDocuments.routes,");
    expect(server).toContain("officeDocumentRoutes: officeDocuments.routes,");
    expect(server).toContain("projectPathAdmission: officeDocuments.projectPathAdmission,");
    expect(server).toContain("officeDocuments.close()");
  });

  it("builds the gateway document service inside the fence when a collaboration database exists", async () => {
    harness = await createOfficeHarness();
    const home = harness.home;
    await mkdir(join(home, "projects/acme"), { recursive: true });
    const projects = { listManagedProjects: async () => ({ projects: [{ id: "proj_shared", localPath: "projects/acme" }] }) };
    vi.stubEnv("MATRIX_USER_ID", "owner");
    const fenced = createGatewayOfficeDocuments({
      homePath: home, projects: projects as never,
      projectOperationAdmission: { withLegacyAdmission: async () => { throw new ProjectFenceError("scope_required"); } },
    });
    expect(fenced.projectPathAdmission).toBeDefined();
    const create = (documents: typeof fenced, path: string) => documents.routes.request("/documents/create", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, paragraphs: ["One"] }),
    });
    expect((await create(fenced, "projects/acme/a.docx")).status).toBe(403);
    expect((await create(fenced, "docs/a.docx")).status).toBe(200);
    const open = createGatewayOfficeDocuments({ homePath: home, projects: projects as never });
    expect(open.projectPathAdmission).toBeUndefined();
    expect((await create(open, "projects/acme/b.docx")).status).toBe(200);
    expect(await readdir(join(home, "projects/acme"))).toEqual(["b.docx"]);
  });
});

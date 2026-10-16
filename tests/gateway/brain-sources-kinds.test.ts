/**
 * Every connectable kind through the real handlers built by startBrainSourcesService: connect (with account pinning
 * where the kind has an account), one sync run through the shared runner, the list view, then remove. Providers are
 * fakes; files live in a temporary home. No network.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrainConnectableSourceKind, BrainSourcesService, BrainSourceSyncRunner,
} from "../../packages/gateway/src/brain/contracts.js";
import {
  runBrainSourceSync, startBrainSourcesService, type BrainSourcesStartDeps,
} from "../../packages/gateway/src/brain/sources/core/index.js";
import type {
  BrainMatrixChatReader, BrainMatrixNotesReader,
} from "../../packages/gateway/src/brain/sources/matrix/index.js";
import type { BrainSlackCaptureReader } from "../../packages/gateway/src/brain/sources/connectors/index.js";
import { fakeIntegrations, ok } from "./helpers/brain-source-connectors-fakes.js";
import { githubFixture } from "./helpers/brain-source-github-fakes.js";
import { createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";
import { OWNER, recordingHooks, SCOPE_A, sourcesResolver } from "./helpers/brain-sources-fixture.js";

const COMPANY = "8a4bd2b8-7b38-4f0e-9a3c-7f6f1d3b2a10";
let home: string;
let harness: BrainHarness;

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "brain-sources-")));
  await mkdir(join(home, "docs"));
  await writeFile(join(home, "docs", "plan.md"), "# Plan\n\nWe decided to ship the sources service.\n");
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});
beforeEach(async () => {
  harness = await createBrainHarness();
});
afterEach(async () => {
  await harness.destroy();
  vi.restoreAllMocks();
});

const notes: BrainMatrixNotesReader = {
  listNotes: async (after) => (after < "n1" ? [{
    id: "n1", title: "Plan", content: "We decided to ship", tags: "work", selected: true,
    updatedAt: "2026-09-30T10:00:00.000Z", contentCut: false,
  }] : []),
  listNoteKeys: async (after) => (after < "n1" ? [{ id: "n1", selected: true }] : []),
};
const chats: BrainMatrixChatReader = {
  get: async (owner, chatId) => owner.ownerId === OWNER && chatId === "chat_a"
    ? { chat: { id: "chat_a", title: "Alpha chat", updatedAt: "2026-10-01T00:00:00.000Z" } } : null,
  getMessages: async (_owner, chatId, { afterSeq }) => chatId === "chat_a" && afterSeq < 1
    ? [{ seq: 1, role: "user", state: "committed", parts: [{ type: "text", text: "Ship it" }], createdAt: "2026-09-30T09:00:00.000Z" }]
    : [],
  list: async () => ({ items: [{ chat: { id: "chat_a", title: "Alpha chat", updatedAt: "2026-10-01T00:00:00.000Z" } }] }),
};
const capture: BrainSlackCaptureReader = {
  readThreads: async () => ({
    status: "ok", truncated: false, documents: [{
      sourceId: createHash("sha256").update("t1").digest("hex"), title: "Slack company thread", text: "We decided to ship",
      permalink: "https://app.slack.com/client/T999/C111/thread/C111-1727000000.000100", provenance: "slack_thread",
      sourceUpdatedAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z",
    }],
  }),
};
const plainIssues = () => githubFixture<{ pull_request?: unknown }[]>("issues-page").filter((issue) => issue.pull_request === undefined);
const integrations = () => fakeIntegrations({
  "github.list_issues_since": (params) => ok(params.page === 1 ? plainIssues() : []),
  "linear.brain_issues": () => ok({ data: { issues: { nodes: [{
    id: "issue-1", identifier: "ENG-1", title: "Fix login", description: "Details", url: "https://linear.app/acme/issue/ENG-1/fix",
    updatedAt: "2026-09-01T00:00:00.000Z", state: { name: "Todo", type: "unstarted" }, labels: { nodes: [] }, archivedAt: null,
  }], pageInfo: { hasNextPage: false, endCursor: null } } } }),
  "linear.brain_comments": () => ok({ data: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
  "linear.brain_project_updates": () => ok({ data: { projectUpdates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
  "google_drive.brain_list_folder": () => ok({ files: [{
    id: "d1", name: "Design", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-10T08:00:00Z",
    webViewLink: "https://docs.google.com/document/d/d1/edit",
  }] }),
  "google_drive.brain_export_text": () => ok("We decided to ship"),
  "google_calendar.brain_list_events": (params) => ok({ items: [{
    id: "e1", status: "confirmed", htmlLink: "https://www.google.com/calendar/event?eid=e1", summary: "Review",
    start: { dateTime: String(params.timeMin) }, end: { dateTime: String(params.timeMin) }, updated: "2026-09-30T12:00:00.000Z",
  }] }),
});

function start(extra: Partial<BrainSourcesStartDeps> = {}): Promise<BrainSourcesService> {
  return startBrainSourcesService({
    kysely: harness.db, repository: harness.repository, resolver: sourcesResolver(home), hooks: recordingHooks(),
    integrations: integrations(), isConnected: async () => true, accounts: async () => ["work"], homePath: home, notes, chats,
    homeOwnerIds: [OWNER], capture, env: {}, ...extra,
  });
}

const CONFIGS: Record<BrainConnectableSourceKind, unknown> = {
  github: { repo: "acme/widgets", mode: "integration", include: { pullRequests: true, reviews: false, issues: true }, since: "2026-01-01" },
  matrix_notes: { folders: [] },
  matrix_files: { roots: ["docs"], extensions: ["md"] },
  matrix_chat: { chatIds: ["chat_a"] },
  linear: { teamKeys: ["ENG"], include: { issues: true, comments: true, projectUpdates: true } },
  google_drive: { folderIds: ["f1"] },
  google_calendar: { calendarIds: ["primary"], includeEventBodies: false, pastDays: 7, futureDays: 14 },
  slack_bridge: { companyScopeId: COMPANY, channelIds: ["C111"] },
};
const PINNED = new Set(["github", "linear", "google_drive", "google_calendar"]);

describe("every kind end to end", () => {
  it.each(Object.keys(CONFIGS) as BrainConnectableSourceKind[])("%s connects, syncs, lists and removes", async (kind) => {
    const sources = await start();
    const { source, created } = await sources.connect(OWNER, "proj_a", { kind, config: CONFIGS[kind] });
    expect(created).toBe(true);
    expect(source.kind).toBe(kind);
    expect(source.externalRef === null).toBe(kind !== "github");
    if (PINNED.has(kind)) expect(source.config).toMatchObject({ accountLabel: "work" });
    const run = await sources.sync(OWNER, "proj_a", source.sourceId);
    expect(run, kind).toMatchObject({ status: "succeeded", caughtUp: true, errorCode: null });
    expect(run.counts.written, kind).toBeGreaterThanOrEqual(1);
    const list = await sources.list(OWNER, "proj_a");
    expect(list.items).toEqual([expect.objectContaining({ sourceId: source.sourceId, lastSync: expect.objectContaining({ status: "succeeded" }) })]);
    expect(list.kinds.find((view) => view.kind === kind)).toEqual({ kind, available: true, reason: null });
    const live = async () => (await harness.repository.listDocuments(SCOPE_A, { sourceId: source.sourceId })).items.length;
    expect(await live()).toBe(run.counts.written);
    await sources.remove(OWNER, "proj_a", source.sourceId, source.revision);
    expect(await live()).toBe(0);
  });
});

describe("start and kind rules", () => {
  it("turns off kinds whose tables fail and kinds without their dependencies, logging only names", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sources = await start({
      bootstraps: { matrix_sources: async () => { throw Object.assign(new Error("lock /secret"), { code: "55P03" }); } },
      isConnected: undefined, accounts: undefined, capture: undefined,
    });
    expect(error).toHaveBeenCalledWith("[brain-sources] matrix_sources sources are off after their tables failed:", "Error", "55P03");
    const kinds = Object.fromEntries((await sources.list(OWNER, "proj_a")).kinds.map((view) => [view.kind, view.reason]));
    expect(kinds).toEqual({
      git: "not_configured", github: "not_configured", matrix_notes: "not_configured", matrix_files: "not_configured",
      matrix_chat: "not_configured", linear: "not_configured", google_drive: "not_configured", google_calendar: "not_configured",
      slack_bridge: "not_configured",
    });
    const failing = await start({ bootstraps: { github: async () => { throw "odd"; }, connectors: async () => { throw new TypeError("x"); } } });
    expect(error).toHaveBeenCalledWith("[brain-sources] github sources are off after their tables failed:", "string", "");
    expect((await failing.list(OWNER, "proj_a")).kinds.filter((view) => view.available).map((view) => view.kind))
      .toEqual(["matrix_notes", "matrix_files", "matrix_chat"]);
  });

  it("refuses a GitHub repository other than the git source's and leaves no github source", async () => {
    await harness.repository.createSource(SCOPE_A, { kind: "git", externalRef: "https://github.com/acme/widgets", label: "Widgets" });
    const sources = await start();
    const other = { ...(CONFIGS.github as object), repo: "other/thing" };
    await expect(sources.connect(OWNER, "proj_a", { kind: "github", config: other })).rejects.toMatchObject({ code: "source_conflict" });
    expect((await harness.repository.listSources(SCOPE_A)).items.map((source) => source.kind)).toEqual(["git"]);
    // checkConfig refuses it before createSource: not even a tombstoned github row is left.
    const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM brain_sources WHERE kind = 'github'`.execute(harness.db);
    expect(rows.rows).toEqual([{ n: 0 }]);
    expect((await sources.connect(OWNER, "proj_a", { kind: "github", config: CONFIGS.github })).created).toBe(true);
    await expect(sources.connect(OWNER, "proj_a", { kind: "github", config: { ...other, repo: "acme/gadgets" } }))
      .rejects.toMatchObject({ code: "source_conflict" });
  });

  it("writes each family's config in the update's transaction, so a refused write leaves the source as it was", async () => {
    const sources = await start({ accounts: async () => ["work", "home"] });
    const github = { ...(CONFIGS.github as object), accountLabel: "work" };
    const linear = { ...(CONFIGS.linear as object), accountLabel: "work" };
    const cases: readonly [BrainConnectableSourceKind, string, object, object][] = [
      ["github", "brain_github_sources", github, { ...github, accountLabel: "home" }],
      ["matrix_notes", "brain_matrix_sources", CONFIGS.matrix_notes as object, { folders: ["work"] }],
      ["linear", "brain_connector_sources", linear, { ...linear, include: { issues: true, comments: false, projectUpdates: true } }],
    ];
    for (const [kind, table, config, next] of cases) {
      const { source } = await sources.connect(OWNER, "proj_a", { kind, config });
      await sql`ALTER TABLE ${sql.table(table)} ADD CONSTRAINT refuse_writes CHECK (false) NOT VALID`.execute(harness.db);
      await expect(sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 1, label: "Renamed", config: next }))
        .rejects.toThrow();
      const kept = (await sources.list(OWNER, "proj_a")).items.find((item) => item.sourceId === source.sourceId);
      expect(kept, kind).toMatchObject({ revision: 1, label: source.label, config: source.config });
      await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT refuse_writes`.execute(harness.db);
      const updated = await sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 1, label: "Renamed", config: next });
      expect(updated, kind).toMatchObject({ sourceId: source.sourceId, revision: 2, label: "Renamed" });
      expect(updated.config, kind).not.toEqual(source.config);
    }
  });

  it("reads a GitHub source again from the start when its window or item types change", async () => {
    const sources = await start();
    const pullsOnly = { ...(CONFIGS.github as object), include: { pullRequests: true, reviews: false, issues: false } };
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "github", config: pullsOnly });
    // The listing holds only issues: each is read and passed over, and the cursor moves past them.
    expect((await sources.sync(OWNER, "proj_a", source.sourceId)).counts.written).toBe(0);
    const issues = { expectedRevision: 1, config: { ...pullsOnly, include: { pullRequests: true, reviews: false, issues: true } } };
    // The reconnect is one transaction: a refused config write leaves the source and its config as they were.
    await sql`ALTER TABLE brain_github_sources ADD CONSTRAINT refuse_writes CHECK (false) NOT VALID`.execute(harness.db);
    await expect(sources.update(OWNER, "proj_a", source.sourceId, issues)).rejects.toThrow();
    expect((await sources.list(OWNER, "proj_a")).items.filter((item) => item.kind === "github"))
      .toEqual([expect.objectContaining({ sourceId: source.sourceId, revision: 1, config: source.config })]);
    await sql`ALTER TABLE brain_github_sources DROP CONSTRAINT refuse_writes`.execute(harness.db);
    const withIssues = await sources.update(OWNER, "proj_a", source.sourceId, issues);
    expect(withIssues).toMatchObject({ revision: 1, label: source.label, config: { issues: true, accountLabel: "work" } });
    expect(withIssues.sourceId).not.toBe(source.sourceId);
    const run = await sources.sync(OWNER, "proj_a", withIssues.sourceId);
    expect(run.counts.written).toBeGreaterThan(0);
    // A setting outside what it reads keeps the source and its cursor.
    const renamed = await sources.update(OWNER, "proj_a", withIssues.sourceId, {
      expectedRevision: 1, config: { ...pullsOnly, include: { pullRequests: true, reviews: false, issues: true }, mode: "integration" },
      label: "Widgets on GitHub",
    });
    expect(renamed).toMatchObject({ sourceId: withIssues.sourceId, revision: 2, label: "Widgets on GitHub" });
    expect((await sources.sync(OWNER, "proj_a", withIssues.sourceId)).counts).toMatchObject({ written: 0, unchanged: 0 });
  });

  it("passes the optional dependencies through: token owners, fetch, limits, git sync and the runner", async () => {
    const runner = vi.fn<BrainSourceSyncRunner>(runBrainSourceSync);
    const network = vi.fn(async () => { throw new Error("no network in tests"); });
    const sources = await start({
      githubTokenOwnerIds: [OWNER], env: { MATRIX_BRAIN_GITHUB_TOKEN: `ghp_${"a".repeat(36)}` }, fetch: network as typeof fetch,
      isConnected: undefined, hooks: undefined, limits: { pagesPerRun: 2 }, runner,
      gitSync: async () => { throw new Error("not called"); },
    });
    const kinds = (await sources.list(OWNER, "proj_a")).kinds;
    expect(kinds.filter((view) => view.available).map((view) => view.kind))
      .toEqual(["git", "github", "matrix_notes", "matrix_files", "matrix_chat", "slack_bridge"]);
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "matrix_notes", config: CONFIGS.matrix_notes });
    expect((await sources.sync(OWNER, "proj_a", source.sourceId)).status).toBe("succeeded");
    expect(runner.mock.calls[0]![0]).toMatchObject({ limits: { pagesPerRun: 2 } });
    expect(runner.mock.calls[0]![0].hooks).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  });

  it("serves options from the kinds that have them and pins accounts only where a kind has one", async () => {
    const sources = await start({ accounts: async () => ["work", "home"] });
    expect(await sources.options(OWNER, "proj_a", "matrix_files", {})).toEqual({
      kind: "matrix_files", items: [{ id: "docs", label: "docs", detail: "docs" }], nextCursor: null,
    });
    expect((await sources.options(OWNER, "proj_a", "matrix_chat", {})).items.map((item) => item.id)).toEqual(["chat_a"]);
    expect(await sources.options(OWNER, "proj_a", "linear", {})).toEqual({ kind: "linear", items: [], nextCursor: null });
    await expect(sources.connect(OWNER, "proj_a", { kind: "linear", config: CONFIGS.linear })).rejects.toMatchObject({ code: "source_config_invalid" });
    const named = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { ...(CONFIGS.linear as object), accountLabel: "home" } });
    expect(named.source.config).toMatchObject({ accountLabel: "home", teamKeys: ["ENG"] });
    expect((await sources.connect(OWNER, "proj_a", { kind: "matrix_chat", config: CONFIGS.matrix_chat })).created).toBe(true);
  });
});

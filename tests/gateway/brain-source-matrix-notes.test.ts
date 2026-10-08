import { KyselyPGlite } from "kysely-pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { BrainFeatureError, type BrainResolvedProject } from "../../packages/gateway/src/brain/contracts.js";
import {
  bootstrapBrainMatrixDatabase, createBrainMatrixNotesHandler, createBrainMatrixNotesReader,
} from "../../packages/gateway/src/brain/sources/matrix/index.js";
import { createMatrixNotesAdapter, noteTags } from "../../packages/gateway/src/brain/sources/matrix/notes.js";
import { encodeMatrixCursor } from "../../packages/gateway/src/brain/sources/matrix/shared.js";
import type { BrainMatrixNotesReader } from "../../packages/gateway/src/brain/sources/matrix/types.js";
import { createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";
import { createMatrixSource, liveTitles, matrixScope, runMatrixLoop, wideLimits } from "./helpers/brain-source-matrix-loop.js";

const project: BrainResolvedProject = { projectId: "proj_a", slug: "a", name: "A", scope: matrixScope };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let appDb: AppDb;
let destroyApp: () => Promise<void>;
let harness: BrainHarness;

async function addNote(n: number, fields: { title?: string | null; content?: string | null; tags?: string | null }) {
  await appDb.raw(`INSERT INTO "notes"."notes" (id, title, content, tags, updated_at) VALUES ($1, $2, $3, $4, $5)`, [
    uuid(n), fields.title ?? null, fields.content ?? null, fields.tags ?? null, "2026-10-01T08:00:00Z",
  ]);
}

beforeAll(async () => {
  const pglite = await KyselyPGlite.create();
  const app = createAppDb({ dialect: pglite.dialect });
  appDb = app.db;
  destroyApp = () => app.db.destroy();
});
afterAll(async () => destroyApp());
beforeEach(async () => {
  harness = await createBrainHarness();
  await bootstrapBrainMatrixDatabase(harness.db);
});
afterEach(async () => {
  await appDb.raw(`DROP SCHEMA IF EXISTS "notes" CASCADE`);
  await harness.destroy();
  vi.restoreAllMocks();
});

async function createNotesTable() {
  await appDb.createAppSchema("notes");
  await appDb.createTable("notes", "notes", { title: "text", content: "text", content_json: "jsonb", pinned: "boolean", tags: "text" });
}

describe("matrix notes source", () => {
  it("syncs notes with tags as labels, filters by folders and tombstones removed notes", async () => {
    await createNotesTable();
    await addNote(1, { title: "Plan", content: "# Plan\nShip the brain.", tags: "work,#Brain" });
    await addNote(2, { title: null, content: "## First line wins\nmore", tags: "home" });
    await addNote(3, { title: "  ", content: "   ", tags: null });
    await addNote(4, { title: "Long", content: "x".repeat(80_000), tags: "work" });
    const handler = createBrainMatrixNotesHandler({ kysely: harness.db, notes: createBrainMatrixNotesReader(appDb) });
    const config = handler.parseConfig({});
    const { externalRef } = handler.identify(project, config);
    const sourceId = await createMatrixSource(harness, "matrix_notes", externalRef);
    const resolution = await handler.createAdapter("owner_a", project, config);
    if (!resolution.ok) throw new Error("adapter");
    const first = await runMatrixLoop(harness, sourceId, externalRef, resolution.adapter, config, { limits: { ...wideLimits, maxUpserts: 2 } });
    expect(first).toMatchObject({ caughtUp: true, written: 4, notices: ["body_truncated"] });
    expect(await liveTitles(harness, sourceId)).toEqual(["First line wins", "Long", "Plan", "Untitled note"]);
    const id = (await harness.repository.listDocuments(matrixScope, { sourceId })).items.find((d) => d.title === "Plan")!;
    expect(await harness.repository.listDocumentRefs(matrixScope, id.documentId)).toEqual([
      { kind: "label", value: "brain" }, { kind: "label", value: "work" },
    ]);
    expect((await runMatrixLoop(harness, sourceId, externalRef, resolution.adapter, config)).written).toBe(0);

    await appDb.raw(`DELETE FROM "notes"."notes" WHERE id = $1`, [uuid(2)]);
    const filtered = handler.parseConfig({ folders: ["#WORK"] });
    const swept = await runMatrixLoop(harness, sourceId, externalRef, resolution.adapter, filtered, {
      limits: { ...wideLimits, maxDeletions: 1 },
    });
    expect(swept).toMatchObject({ caughtUp: true, deleted: 2, skipped: 1 });
    expect(await liveTitles(harness, sourceId)).toEqual(["Long", "Plan"]);
  });

  it("keeps each page within maxRefs and refuses limits too small for one note", async () => {
    await createNotesTable();
    for (const n of [1, 2, 3]) {
      await addNote(n, { title: `Note ${n}`, content: "body", tags: Array.from({ length: 12 }, (_, i) => `t${n}-${i}`).join(",") });
    }
    const adapter = createMatrixNotesAdapter(createBrainMatrixNotesReader(appDb));
    const sourceId = await createMatrixSource(harness, "matrix_notes", "matrix_notes");
    const limits = { ...wideLimits, maxRefs: 20 };
    // 12 refs per note: one note per scan page (the loop checks refs per page), then the sweep page.
    expect(await runMatrixLoop(harness, sourceId, "matrix_notes", adapter, { folders: [] }, { limits }))
      .toMatchObject({ caughtUp: true, written: 3, pages: 4 });
    for (const small of [{ maxRefs: 19 }, { maxUpserts: 0 }]) {
      const result = await runMatrixLoop(harness, sourceId, "matrix_notes", adapter, { folders: [] }, { limits: { ...limits, ...small } });
      expect(result.failure).toEqual({ ok: false, code: "invalid_options" });
    }
  });

  it("selects a note by any of its tags, not only the twenty kept as refs", async () => {
    await createNotesTable();
    const tags = Array.from({ length: 25 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    await addNote(1, { title: "Many tags", content: "body", tags: tags.join(",") });
    await addNote(2, { title: "Other", content: "body", tags: "other" });
    const adapter = createMatrixNotesAdapter(createBrainMatrixNotesReader(appDb));
    const sourceId = await createMatrixSource(harness, "matrix_notes", "matrix_notes");
    expect((await runMatrixLoop(harness, sourceId, "matrix_notes", adapter, { folders: [] })).written).toBe(2);
    // t24 is the 25th tag: the scan must keep the note and the sweep must not tombstone it.
    const selected = await runMatrixLoop(harness, sourceId, "matrix_notes", adapter, { folders: ["t24"] });
    expect(selected).toMatchObject({ caughtUp: true, deleted: 1, skipped: 1 });
    expect(await liveTitles(harness, sourceId)).toEqual(["Many tags"]);
    const doc = (await harness.repository.listDocuments(matrixScope, { sourceId })).items[0]!;
    expect(await harness.repository.listDocumentRefs(matrixScope, doc.documentId))
      .toEqual(tags.slice(0, 20).map((value) => ({ kind: "label", value })));
  });

  it("treats a missing notes table as no notes and reports reader failures as provider_unavailable", async () => {
    const reader = createBrainMatrixNotesReader(appDb);
    expect(await reader.listNotes("", 10)).toEqual([]);
    const sourceId = await createMatrixSource(harness, "matrix_notes", "matrix_notes");
    const adapter = createMatrixNotesAdapter(reader);
    expect(await runMatrixLoop(harness, sourceId, "matrix_notes", adapter, { folders: [] })).toMatchObject({ caughtUp: true, pages: 2 });
    const broken = createBrainMatrixNotesReader({ raw: async () => { throw new Error("down"); } });
    const odd = createBrainMatrixNotesReader({ raw: async () => { throw "down"; } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await runMatrixLoop(harness, sourceId, "matrix_notes", createMatrixNotesAdapter(broken), { folders: [] });
    expect(failed.failure).toEqual({ ok: false, code: "provider_unavailable" });
    expect(console.error).toHaveBeenCalledWith("[brain-matrix] notes read failed:", "Error");
    await runMatrixLoop(harness, sourceId, "matrix_notes", createMatrixNotesAdapter(odd), { folders: [] });
    expect(console.error).toHaveBeenLastCalledWith("[brain-matrix] notes read failed:", "UnknownError");
  });

  it("drops malformed rows, refuses foreign cursors and caps a pass", async () => {
    const reader = createBrainMatrixNotesReader({
      raw: async () => ({ rows: [{ id: "bad id", tags: 1 }, { id: "n1", title: 5, content: null, tags: 7, updated_at: "nope" }] }),
    });
    expect(await reader.listNotes("", 5)).toEqual([
      { id: "n1", title: null, content: null, contentCut: false, tags: null, updatedAt: "1970-01-01T00:00:00.000Z" },
    ]);
    expect(await reader.listNoteKeys("", 5)).toEqual([{ id: "n1", tags: null }]);
    const adapter = createMatrixNotesAdapter(reader);
    const context = {
      scope: matrixScope, sourceId: "src_" + "0".repeat(32), externalRef: "matrix_notes", config: { folders: [] },
      limits: wideLimits, signal: new AbortController().signal, documents: harness.repository, now: harness.now,
    };
    expect(await adapter.readPage({ ...context, cursor: "mn1:!!" })).toEqual({ ok: false, code: "cursor_invalid" });
    expect(await adapter.readPage({ ...context, cursor: "mf1:e30" })).toEqual({ ok: false, code: "cursor_invalid" });
    const capped = await adapter.readPage({
      ...context, cursor: encodeMatrixCursor("mn1:", { v: 1, phase: "scan", after: "", seen: 4_999 }),
    });
    expect(capped).toMatchObject({ ok: true, page: { notices: ["items_truncated"], upserts: [{ title: "Untitled note" }] } });
    const full = await adapter.readPage({
      ...context, cursor: encodeMatrixCursor("mn1:", { v: 1, phase: "scan", after: "", seen: 5_000 }),
    });
    expect(full).toMatchObject({ ok: true, page: { upserts: [], caughtUp: false } });
  });

  it("stops the key scan at the pass cap", async () => {
    const keys = Array.from({ length: 1_000 }, (_, index) => ({ id: `n${String(index).padStart(5, "0")}`, tags: null }));
    const reader: BrainMatrixNotesReader = { listNotes: async () => [], listNoteKeys: vi.fn(async () => keys) };
    const adapter = createMatrixNotesAdapter(reader);
    const result = await adapter.readPage({
      scope: matrixScope, sourceId: "src_" + "0".repeat(32), externalRef: "matrix_notes", config: { folders: [] },
      cursor: encodeMatrixCursor("mn1:", { v: 1, phase: "sweep", after: null }), limits: wideLimits,
      signal: new AbortController().signal, documents: harness.repository, now: harness.now,
    });
    expect(result).toMatchObject({ ok: true, page: { caughtUp: true, deletions: [] } });
    expect(reader.listNoteKeys).toHaveBeenCalledTimes(5);
  });

  it("parses, stores, views and gates the notes config", async () => {
    const handler = createBrainMatrixNotesHandler({ kysely: harness.db, notes: null, now: harness.now });
    expect(handler.parseConfig({ folders: ["#Work", "home"] })).toEqual({ folders: ["home", "work"] });
    for (const bad of [{ folders: ["x"] }, { folders: ["a1", "#A1"] }, { other: 1 }, null, { folders: ["ab"], pad: "x".repeat(9_000) }]) {
      expect(() => handler.parseConfig(bad)).toThrow(BrainFeatureError);
    }
    expect(handler.identify(project, { folders: ["work"] })).toEqual({ externalRef: "matrix_notes", label: "Notes: work" });
    expect(handler.viewConfig({ folders: ["work"] })).toEqual({ folders: ["work"] });
    expect(await handler.availability("owner_a")).toEqual({ available: false, reason: "not_configured" });
    expect(await handler.createAdapter("owner_a", project, { folders: [] })).toEqual({ ok: false, code: "not_connected" });
    const sourceId = await createMatrixSource(harness, "matrix_notes", "matrix_notes");
    expect(await handler.loadConfig(matrixScope, sourceId)).toBeNull();
    await handler.saveConfig(matrixScope, sourceId, { folders: ["work"] });
    await handler.saveConfig(matrixScope, sourceId, { folders: ["home"] });
    expect(await handler.loadConfig(matrixScope, sourceId)).toEqual({ folders: ["home"] });
    const ready = createBrainMatrixNotesHandler({ kysely: harness.db, notes: createBrainMatrixNotesReader(appDb) });
    expect(await ready.availability("owner_a")).toEqual({ available: true });
    await ready.saveConfig(matrixScope, sourceId, { folders: [] });
    expect(await ready.loadConfig(matrixScope, sourceId)).toEqual({ folders: [] });
    expect(noteTags("a, bb #cc,Bad_tag,dd")).toEqual(["bb", "cc", "dd"]);
  });
});

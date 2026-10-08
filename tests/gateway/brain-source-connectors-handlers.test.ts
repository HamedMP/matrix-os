import { z } from "zod/v4";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapBrainConnectorDatabase, createBrainGoogleCalendarHandler, createBrainGoogleDriveHandler,
  createBrainLinearHandler, createBrainSlackBridgeHandler,
} from "../../packages/gateway/src/brain/sources/connectors/index.js";
import { createSnapshotAdapter } from "../../packages/gateway/src/brain/sources/connectors/snapshot.js";
import {
  RefSet, canonicalPermalink, clampTitle, composeBody, decodeCursor, encodeCursor, isoInstant, personKey,
} from "../../packages/gateway/src/brain/sources/connectors/text.js";
import { connectorHarness, connectorProject, connectorScope, fakeIntegrations, type ConnectorHarness } from "./helpers/brain-source-connectors-fakes.js";

let harness: ConnectorHarness | null = null;
afterEach(async () => {
  await harness?.destroy();
  harness = null;
});

const refuses = (run: () => unknown) =>
  expect(run).toThrow(expect.objectContaining({ name: "BrainFeatureError", code: "source_config_invalid" }));

describe("connector kind handlers", () => {
  it("parse bounded configs with defaults and refuse anything else", async () => {
    harness = await connectorHarness("linear");
    const deps = { kysely: harness.db, integrations: fakeIntegrations({}) };
    const linear = createBrainLinearHandler(deps);
    expect(linear.parseConfig({ teamKeys: ["ENG"] })).toEqual({
      teamKeys: ["ENG"], include: { issues: true, comments: true, projectUpdates: true },
    });
    for (const raw of [
      { teamKeys: [] }, { teamKeys: ["eng"] }, { teamKeys: ["ENG", "ENG"] }, { teamKeys: ["ENG"], token: "secret" },
      { teamKeys: ["ENG"], include: { issues: false, comments: false, projectUpdates: false } },
      { teamKeys: ["ENG"], accountLabel: "a\u0007b" }, null,
    ]) refuses(() => linear.parseConfig(raw));
    const calendar = createBrainGoogleCalendarHandler(deps);
    expect(calendar.parseConfig({ calendarIds: ["primary"] })).toEqual({
      calendarIds: ["primary"], includeEventBodies: false, pastDays: 30, futureDays: 30,
    });
    for (const calendarIds of [["a b"], [".."], ["."], [""]]) refuses(() => calendar.parseConfig({ calendarIds }));
    expect(calendar.parseConfig({ calendarIds: ["...", "a.b@x"] }).calendarIds).toEqual(["...", "a.b@x"]);
    refuses(() => calendar.parseConfig({ calendarIds: ["x"], pastDays: 91 }));
    const drive = createBrainGoogleDriveHandler(deps);
    refuses(() => drive.parseConfig({ folderIds: ["../x"] }));
    const slack = createBrainSlackBridgeHandler({ kysely: harness.db });
    expect(slack.parseConfig({ companyScopeId: "8a4bd2b8-7b38-4f0e-9a3c-7f6f1d3b2a10" }).channelIds).toEqual([]);
    refuses(() => slack.parseConfig({ companyScopeId: "x", channelIds: [] }));
    refuses(() => slack.parseConfig({ companyScopeId: "8a4bd2b8-7b38-4f0e-9a3c-7f6f1d3b2a10", channelIds: ["D123"] }));
  });

  it("name sources without a network call and show redacted configs", async () => {
    harness = await connectorHarness("linear");
    const deps = { kysely: harness.db, integrations: fakeIntegrations({}) };
    const linear = createBrainLinearHandler(deps);
    const config = linear.parseConfig({ teamKeys: ["OPS", "ENG"], accountLabel: "work" });
    const named = linear.identify(connectorProject, config);
    expect(named.label).toBe("Linear OPS, ENG");
    expect(named.externalRef).toMatch(/^linear:[a-f0-9]{40}$/);
    expect(linear.identify(connectorProject, { ...config, teamKeys: ["ENG", "OPS"] }).externalRef).toBe(named.externalRef);
    const plain = linear.parseConfig({ teamKeys: ["ENG"] });
    expect([linear.identify(connectorProject, plain).label, linear.viewConfig(plain).accountLabel]).toEqual(["Linear ENG", null]);
    expect(linear.viewConfig(config)).toEqual({ teamKeys: ["OPS", "ENG"], accountLabel: "work", issues: true, comments: true, projectUpdates: true });
    const drive = createBrainGoogleDriveHandler(deps);
    expect(drive.identify(connectorProject, { folderIds: ["a"] }).label).toBe("Google Drive (1 folder)");
    expect(drive.identify(connectorProject, { folderIds: ["a", "b"] }).label).toBe("Google Drive (2 folders)");
    expect(drive.viewConfig({ folderIds: ["a"] })).toEqual({ folderIds: ["a"], accountLabel: null });
    const calendar = createBrainGoogleCalendarHandler(deps);
    const cal = { calendarIds: ["primary"], includeEventBodies: true, pastDays: 1, futureDays: 2 };
    expect(calendar.identify(connectorProject, cal).label).toBe("Google Calendar (1 calendar)");
    expect(calendar.identify(connectorProject, { ...cal, calendarIds: ["a", "b"] }).label).toBe("Google Calendar (2 calendars)");
    expect(calendar.viewConfig(cal)).toEqual({ ...cal, accountLabel: null });
    const slack = createBrainSlackBridgeHandler({ kysely: harness.db });
    const bridge = { companyScopeId: "8a4bd2b8-7b38-4f0e-9a3c-7f6f1d3b2a10", channelIds: ["C1A"] };
    expect(slack.identify(connectorProject, bridge)).toMatchObject({ label: "Slack threads" });
    expect(slack.viewConfig(bridge)).toEqual(bridge);
    expect(await linear.availability("owner_a")).toEqual({ available: false, reason: "not_configured" });
  });

  it("run only the pinned account, never the first of several", async () => {
    harness = await connectorHarness("linear");
    let labels = ["work"];
    const deps = {
      kysely: harness.db, integrations: fakeIntegrations({}), isConnected: async () => true, accounts: async () => labels,
    };
    const linear = createBrainLinearHandler(deps);
    const config = linear.parseConfig({ teamKeys: ["ENG"] });
    expect((await linear.createAdapter("owner_a", connectorProject, config)).ok).toBe(true);
    labels = ["home", "work"];
    expect(await linear.createAdapter("owner_a", connectorProject, config)).toEqual({ ok: false, code: "not_connected" });
    expect((await linear.createAdapter("owner_a", connectorProject, { ...config, accountLabel: "work" })).ok).toBe(true);
    labels = ["home"];
    expect(await linear.createAdapter("owner_a", connectorProject, { ...config, accountLabel: "work" }))
      .toEqual({ ok: false, code: "not_connected" });
  });

  it("store one config per source, refuse other kinds and missing sources, and erase with the scope", async () => {
    harness = await connectorHarness("linear");
    await bootstrapBrainConnectorDatabase(harness.db);
    const deps = { kysely: harness.db, integrations: fakeIntegrations({}) };
    const linear = createBrainLinearHandler(deps);
    const config = linear.parseConfig({ teamKeys: ["ENG"] });
    expect(await linear.loadConfig(connectorScope, harness.sourceId)).toBeNull();
    await linear.saveConfig(connectorScope, harness.sourceId, config);
    await linear.saveConfig(connectorScope, harness.sourceId, { ...config, teamKeys: ["OPS"] });
    expect(await linear.loadConfig(connectorScope, harness.sourceId)).toMatchObject({ teamKeys: ["OPS"] });
    const drive = createBrainGoogleDriveHandler(deps);
    expect(await drive.loadConfig(connectorScope, harness.sourceId)).toBeNull();
    await expect(drive.saveConfig(connectorScope, harness.sourceId, { folderIds: ["f"] })).rejects.toMatchObject({ code: "source_config_invalid" });
    await expect(linear.saveConfig(connectorScope, `src_${"1".repeat(32)}`, config)).rejects.toMatchObject({ code: "source_not_found" });
    await expect(linear.saveConfig(connectorScope, harness.sourceId, { ...config, accountLabel: "x".repeat(9_000) }))
      .rejects.toMatchObject({ code: "source_config_invalid" });
    await expect(linear.saveConfig({ ownerId: "owner_a", scopeId: "x".repeat(300) }, harness.sourceId, config)).rejects.toThrow();
    await harness.db.updateTable("brain_connector_sources" as never).set({ config: { teamKeys: [] } } as never).execute();
    await expect(linear.loadConfig(connectorScope, harness.sourceId)).rejects.toMatchObject({ code: "source_config_invalid" });
    await harness.repository.eraseScope(connectorScope);
    expect(await linear.loadConfig(connectorScope, harness.sourceId)).toBeNull();
  });
});

describe("connector text helpers", () => {
  it("bound titles, bodies, links, person keys and refs", () => {
    expect(clampTitle("  a\n b  ", "x")).toBe("a b");
    expect(clampTitle(null, " fallback ")).toBe("fallback");
    expect(composeBody("t", "  ", ["f"])).toEqual({ body: "f", truncated: false });
    expect(canonicalPermalink("https://Example.com/a b")).toBe("https://example.com/a%20b");
    for (const raw of ["http://x.y", "https://u:p@x.y", "not a url", 5, `https://x.y/${"a".repeat(2_100)}`]) expect(canonicalPermalink(raw)).toBe("");
    expect(canonicalPermalink(`https://x.y/${"\u00e9".repeat(400)}`)).toBe("");
    expect(personKey("email", " A@B.C ")).toBe("email:a@b.c");
    expect(personKey("linear", "")).toBeNull();
    expect(personKey("linear", "a\u0001")).toBeNull();
    expect(isoInstant("x")).toBeNull();
    const refs = new RefSet().add("handle", "A").add("handle", "B").add("label", "a\u0000b").add("label", "x".repeat(600))
      .add("label", undefined).add("label", "y").add("label", "y");
    expect(refs.list()).toEqual([{ kind: "handle", value: "A" }, { kind: "label", value: "a\uFFFDb" }, { kind: "label", value: "y" }]);
    const many = new RefSet();
    for (let index = 0; index < 250; index += 1) {
      many.add(index < 50 ? "attendee" : index < 100 ? "participant" : "commit", `email:p${index}@x.y`);
    }
    many.add("label", "late");
    expect(many.list()).toHaveLength(200);
  });

  it("encode and decode versioned cursors and refuse damaged ones", () => {
    const schema = z.object({ v: z.literal(1) }).strict();
    const text = encodeCursor("t1", { v: 1 });
    expect(decodeCursor("t1", text, schema)).toEqual({ v: 1 });
    expect(decodeCursor("t2", text, schema)).toBeNull();
    expect(decodeCursor("t1", null, schema)).toBeNull();
    expect(decodeCursor("t1", "t1:%%%", schema)).toBeNull();
    expect(decodeCursor("t1", encodeCursor("t1", { v: 2 }), schema)).toBeNull();
    expect(() => encodeCursor("t1", { pad: "x".repeat(2_000) })).toThrow(RangeError);
    // Only a syntax error means a damaged cursor; any other parse failure propagates.
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw new RangeError("too deep"); });
    expect(() => decodeCursor("t1", text, schema)).toThrow(RangeError);
    parse.mockRestore();
  });
});

describe("snapshot adapter", () => {
  const id = (n: number) => `${n}`.padStart(64, "0");
  const stamp = "2026-09-01T00:00:00.000Z";
  function setup(
    stored: number[], options: { storedMax?: number; retain?: number; sweepOnMigrate?: boolean } = {}, complete = true,
  ) {
    let lists = 0;
    const documents = {
      async listDocuments(_scope: unknown, options: { cursor?: string | null }) {
        const index = options.cursor === null || options.cursor === undefined ? 0 : Number(options.cursor);
        const item = stored[index];
        return {
          items: item === undefined ? [] : [{ documentId: id(item), sourceUpdatedAt: `2026-08-${10 + item}T00:00:00.000Z` }],
          nextCursor: index + 1 < stored.length ? String(index + 1) : null,
        };
      },
    };
    const adapter = createSnapshotAdapter<object, { documentId: string; stamp: string }>({
      kind: "slack_bridge", cursorPrefix: "t1", fingerprint: "f", buildsPerPage: 10, sweep: options.retain === undefined,
      ...options,
      list: async () => {
        lists += 1;
        return { ok: true, value: { items: [{ documentId: id(1), stamp: "2026-09-02T00:00:00.000Z" }, { documentId: id(2), stamp }],
          complete, gone: [id(3), id(4)], notices: [] } };
      },
      build: async (item) => ({ ok: true, value: { upsert: {
        documentId: item.documentId, title: "t", body: "b", permalink: "", sourceUpdatedAt: item.stamp, provenance: "slack_thread",
        refs: [{ kind: "channel", value: "T1/C1" }],
      }, notices: [] } }),
    });
    const read = (cursor: string | null, maxRefs = 10) => adapter.readPage({
      scope: connectorScope, sourceId: `src_${"0".repeat(32)}`, externalRef: "x", config: {}, cursor,
      limits: { maxUpserts: 10, maxDeletions: 10, maxRefs }, signal: new AbortController().signal,
      documents: documents as never, now: () => new Date(stamp),
    });
    return { read, lists: () => lists };
  }

  it("deletes gone ids only when stored and sweeps only after reading every stored document", async () => {
    const full = await setup([3, 5]).read(null);
    expect(full.ok && full.page.deletions).toEqual([id(3), id(5)]);
    const capped = await setup([3, 5], { storedMax: 1 }).read(null);
    expect(capped.ok && [capped.page.deletions, capped.page.notices]).toEqual([[id(3)], ["items_truncated"]]);
  });

  it("keeps at most retain documents by deleting the oldest stored ones missing from the listing", async () => {
    const kept = await setup([3, 5, 7, 6], { retain: 3 }).read(null);
    expect(kept.ok && kept.page.deletions).toEqual([id(3), id(5), id(6)]);
    const under = await setup([5], { retain: 3 }).read(null);
    expect(under.ok && under.page.deletions).toEqual([]);
  });

  it("sweeps past retain on a config change once a listing is complete, keeping the re-render open until then", async () => {
    const partial = await setup([3, 5, 6], { retain: 10, sweepOnMigrate: true }, false).read(null);
    expect(partial.ok && [partial.page.deletions, partial.page.caughtUp]).toEqual([[id(3)], true]);
    const cursor = partial.ok ? partial.page.nextCursor : null;
    const swept = await setup([5, 6], { retain: 10, sweepOnMigrate: true }).read(cursor);
    expect(swept.ok && swept.page.deletions).toEqual([id(5), id(6)]);
    const settled = await setup([5, 6], { retain: 10, sweepOnMigrate: true }).read(swept.ok ? swept.page.nextCursor : null);
    expect(settled.ok && settled.page.deletions).toEqual([]);
  });

  it("splits a page at the ref cap and plans again when the cursor moved elsewhere", async () => {
    const run = setup([]);
    const first = await run.read(null, 1);
    expect(first.ok && [first.page.upserts.length, first.page.caughtUp]).toEqual([1, false]);
    const next = await run.read(first.ok ? first.page.nextCursor : null, 1);
    expect(next.ok && next.page.caughtUp).toBe(true);
    expect(run.lists()).toBe(1);
    await run.read("t1:other");
    expect(run.lists()).toBe(2);
  });
});

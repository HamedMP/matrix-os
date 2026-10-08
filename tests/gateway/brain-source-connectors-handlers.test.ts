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

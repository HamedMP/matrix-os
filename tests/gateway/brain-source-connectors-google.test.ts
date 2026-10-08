import { afterEach, describe, expect, it } from "vitest";
import type {
  BrainGoogleCalendarSourceConfig, BrainIntegrationCallOutcome, BrainSourceKindHandler,
} from "../../packages/gateway/src/brain/contracts.js";
import {
  createBrainGoogleCalendarHandler, createBrainGoogleDriveHandler, type BrainConnectorHandlerDeps,
} from "../../packages/gateway/src/brain/sources/connectors/index.js";
import { connectorDocumentId } from "../../packages/gateway/src/brain/sources/connectors/text.js";
import {
  connectorHarness, connectorScope, fakeIntegrations, ok, type ConnectorHarness, type FakeRoute,
} from "./helpers/brain-source-connectors-fakes.js";

let harness: ConnectorHarness | null = null;
afterEach(async () => {
  await harness?.destroy();
  harness = null;
});

const DOC = "application/vnd.google-apps.document";
const FOLDER = "application/vnd.google-apps.folder";
const file = (id: string, mimeType = DOC, extra: Record<string, unknown> = {}) => ({
  id, name: `Doc ${id}`, mimeType, modifiedTime: "2026-09-10T08:00:00Z", webViewLink: `https://docs.google.com/document/d/${id}/edit`,
  ...extra,
});
const runner = <T>(create: (deps: BrainConnectorHandlerDeps) => BrainSourceKindHandler<T>) =>
  async (routes: Record<string, FakeRoute>, config: T, limits = {}) => {
    const integrations = fakeIntegrations(routes);
    const isConnected = async () => true;
    return { integrations, result: await harness!.run(create({ kysely: harness!.db, integrations, isConnected }), config, limits) };
  };
const driveRun = runner(createBrainGoogleDriveHandler);
const calendarRun = runner(createBrainGoogleCalendarHandler);

describe("Google Drive source", () => {
  it("exports Google Docs from folders and subfolders, skips other files and sweeps removed docs", async () => {
    harness = await connectorHarness("google_drive");
    let listing: Record<string, { files: unknown[]; nextPageToken?: string }[]> = {
      f1: [{ files: [file("d1", DOC, { lastModifyingUser: { emailAddress: "Ana@Example.com" } }), file("p1", "application/pdf"),
        file("s1", FOLDER)], nextPageToken: "t2" }, { files: [file("d2", DOC, { modifiedTime: undefined }),
        file("d3", DOC, { webViewLink: null }), file("s1", FOLDER)] }],
      s1: [{ files: [file("d1"), file("s2", FOLDER)] }],
      s2: [{ files: [file("d4"), file("s3", FOLDER)] }],
    };
    const routes: Record<string, FakeRoute> = {
      "google_drive.brain_list_folder": (params) => {
        const pages = listing[String(params.folderId)] ?? [{ files: [] }];
        return ok(pages[params.pageToken === "t2" ? 1 : 0]);
      },
      "google_drive.brain_export_text": (params) => params.fileId === "d4" ? { status: "not_found" }
        : ok(params.fileId === "d3" ? "y".repeat(70_000) : `Text of ${String(params.fileId)}`),
    };
    const { integrations, result } = await driveRun(routes, { folderIds: ["f1"], accountLabel: "me" });
    expect(result).toMatchObject({ status: "succeeded", caughtUp: true, skipped: 1, counts: { written: 2 }, notices: ["body_truncated"] });
    expect(integrations.calls.filter((call) => call.action === "brain_list_folder").map((call) => call.params.folderId))
      .toEqual(["f1", "f1", "s1", "s2"]);
    const d1 = connectorDocumentId("google_drive", harness.externalRef, ["file", "d1"]);
    expect(await harness.repository.getDocument(connectorScope, d1)).toMatchObject({
      title: "Doc d1", body: "Text of d1\n\nGoogle Doc: Doc d1\nModified: 2026-09-10T08:00:00.000Z",
      permalink: "https://docs.google.com/document/d/d1/edit", provenance: "google_doc",
      sourceUpdatedAt: "2026-09-10T08:00:00.000Z",
    });
    expect(await harness.repository.listDocumentRefs(connectorScope, d1)).toEqual([{ kind: "author", value: "email:ana@example.com" }]);

    listing = { ...listing, f1: [{ files: [file("s1", FOLDER)], nextPageToken: "t2" }, listing.f1![1]!],
      s1: [{ files: [file("s2", FOLDER)] }] };
    integrations.calls.length = 0;
    const again = await driveRun(routes, { folderIds: ["f1"], accountLabel: "me" });
    expect(again.result.counts).toMatchObject({ deleted: 1, written: 0 });
    expect(again.integrations.calls.filter((call) => call.action === "brain_export_text").map((call) => call.params.fileId))
      .toEqual(["d4"]);
    expect(await harness.liveIds()).toEqual([connectorDocumentId("google_drive", harness.externalRef, ["file", "d3"])]);
  });

  it("sweeps nothing when the listing is cut short and reports why", async () => {
    harness = await connectorHarness("google_drive");
    const endless = await driveRun({
      "google_drive.brain_list_folder": (params) => ok({ files: [file(`x${String(params.pageToken ?? "0")}`)],
        nextPageToken: `${Number(params.pageToken ?? 0) + 1}` }),
      "google_drive.brain_export_text": () => ok("text"),
    }, { folderIds: ["f1"] }, { pagesPerRun: 1 });
    expect(endless.result).toMatchObject({ notices: ["pages_capped"], counts: { written: 10 }, caughtUp: false });
    const many = await driveRun({
      "google_drive.brain_list_folder": (params) => ok(params.folderId === "root"
        ? { files: Array.from({ length: 31 }, (_, index) => file(`sub${index}`, FOLDER)) } : { files: [] }),
    }, { folderIds: ["root"] });
    expect(many.result.notices).toEqual(["items_truncated"]);
    const huge = await driveRun({
      "google_drive.brain_list_folder": (params) => ok({
        files: Array.from({ length: 1_000 }, (_, index) => file(`${String(params.pageToken ?? "a")}-${index}`)),
        nextPageToken: params.pageToken === undefined ? "b" : params.pageToken === "b" ? "c" : undefined,
      }),
      "google_drive.brain_export_text": () => ok("t"),
    }, { folderIds: ["f1"] }, { pagesPerRun: 1 });
    expect(huge.result.notices).toEqual(["items_truncated"]);
    const partial = await driveRun({
      "google_drive.brain_list_folder": () => ok({ files: [], incompleteSearch: true }),
    }, { folderIds: ["f1"] });
    expect(partial.result.counts.deleted).toBe(0);
    const failed = await driveRun({ "google_drive.brain_list_folder": () => ({ status: "unauthorized" }) }, { folderIds: ["f1"] });
    expect(failed.result.errorCode).toBe("auth_failed");
    const limited = await driveRun({
      "google_drive.brain_list_folder": () => ok({ files: [file("z", DOC, { modifiedTime: "2026-09-30T00:00:00Z" })] }),
      "google_drive.brain_export_text": () => ({ status: "rate_limited", retryAfterSeconds: 5 }),
    }, { folderIds: ["f1"] });
    expect(limited.result).toMatchObject({ errorCode: "rate_limited", retryAfterSeconds: 5 });
  });

  it("keeps a slow page, saves what a page built before a failure and skips files it cannot export or may not read", async () => {
    harness = await connectorHarness("google_drive");
    const at = (day: number) => ({ modifiedTime: `2026-09-0${day}T00:00:00Z` });
    let big: BrainIntegrationCallOutcome = { status: "rate_limited", retryAfterSeconds: 5 };
    const routes: Record<string, FakeRoute> = {
      "google_drive.brain_list_folder": async (_params, listSignal) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        listSignal.throwIfAborted();
        return ok({ files: [file("old", DOC, at(1)), file("big", DOC, at(2)), file("new", DOC, at(3)), file("denied", DOC, at(4)),
          file("locked", DOC, { capabilities: { canDownload: false } })] });
      },
      "google_drive.brain_export_text": (params) => params.fileId === "big" ? big
        : params.fileId === "denied" ? { status: "unauthorized" } : ok(`Text of ${String(params.fileId)}`),
    };
    const limited = await driveRun(routes, { folderIds: ["f1"] }, { runBudgetMs: 5 });
    expect(limited.result).toMatchObject({ status: "failed", errorCode: "rate_limited", pages: 1, counts: { written: 1 } });
    big = { status: "invalid" };
    const skipped = await driveRun(routes, { folderIds: ["f1"] }, { runBudgetMs: 5 });
    expect(skipped.result).toMatchObject({ status: "succeeded", caughtUp: true, skipped: 2, counts: { written: 1 }, notices: ["too_large_skipped"] });
    const exports = [...limited.integrations.calls, ...skipped.integrations.calls]
      .filter((call) => call.action === "brain_export_text").map((call) => call.params.fileId);
    expect(exports).toEqual(["old", "big", "big", "new", "denied"]);
    const id = (fileId: string) => connectorDocumentId("google_drive", harness!.externalRef, ["file", fileId]);
    expect(await harness.liveIds()).toEqual([id("old"), id("new")].sort());
  });
});

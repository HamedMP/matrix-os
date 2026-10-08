import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { BrainSlackBridgeSourceConfig } from "../../packages/gateway/src/brain/contracts.js";
import {
  createBrainSlackBridgeHandler, type BrainSlackCaptureDocument, type BrainSlackCaptureOutcome,
  type BrainSlackCaptureReader,
} from "../../packages/gateway/src/brain/sources/connectors/index.js";
import { connectorDocumentId } from "../../packages/gateway/src/brain/sources/connectors/text.js";
import { connectorHarness, connectorProject, connectorScope, type ConnectorHarness } from "./helpers/brain-source-connectors-fakes.js";

let harness: ConnectorHarness | null = null;
afterEach(async () => {
  await harness?.destroy();
  harness = null;
});

const COMPANY = "8a4bd2b8-7b38-4f0e-9a3c-7f6f1d3b2a10";
const config: BrainSlackBridgeSourceConfig = { companyScopeId: COMPANY, channelIds: ["C111"] };
const sourceId = (seed: string) => createHash("sha256").update(seed).digest("hex");
const capture = (seed: string, channel = "C111", extra: Partial<BrainSlackCaptureDocument> = {}): BrainSlackCaptureDocument => ({
  sourceId: sourceId(seed), title: "Slack company thread", text: `Thread ${seed}: we decided to ship`,
  permalink: `https://app.slack.com/client/T999/${channel}/thread/${channel}-1727000000.000100`,
  provenance: "slack_thread", sourceUpdatedAt: "2026-09-20T10:00:00.000Z", updatedAt: `2026-09-2${seed.length % 10}T10:00:00.000Z`,
  ...extra,
});

function reader(answer: () => BrainSlackCaptureOutcome | Promise<BrainSlackCaptureOutcome>) {
  const calls: { ownerId: string; scope: string; limit: number }[] = [];
  const capture: BrainSlackCaptureReader = {
    readThreads: async (ownerId, scope, limit) => {
      calls.push({ ownerId, scope, limit });
      return answer();
    },
  };
  return { calls, capture };
}

function run(capture: BrainSlackCaptureReader, cfg: BrainSlackBridgeSourceConfig = config, limits = {}, providerTimeoutMs = 10_000) {
  return harness!.run(createBrainSlackBridgeHandler({ kysely: harness!.db, capture, providerTimeoutMs }), cfg, limits);
}

const threadId = (seed: string) => connectorDocumentId("slack_bridge", harness!.externalRef, ["thread", sourceId(seed)]);

describe("Slack bridge source", () => {
  it("copies captured slack threads of allowed channels and skips everything else", async () => {
    harness = await connectorHarness("slack_bridge");
    const { calls, capture: capturer } = reader(() => ({
      status: "ok", truncated: false, documents: [
        capture("a"), capture("b", "C222"), capture("c", "C111", { provenance: "manually_published" }),
        capture("d", "C111", { permalink: "https://example.com/x" }), { ...capture("e"), sourceId: "nope" },
        capture("f", "C111", { updatedAt: "never" }), capture("g", "C111", { text: "z".repeat(65_536), title: " " }),
      ],
    }));
    const result = await run(capturer);
    expect(result).toMatchObject({ status: "succeeded", counts: { written: 2 }, notices: ["body_truncated"] });
    expect(calls).toEqual([{ ownerId: "owner_a", scope: COMPANY, limit: 1_000 }]);
    expect(await harness.repository.getDocument(connectorScope, threadId("a"))).toMatchObject({
      title: "Slack company thread", provenance: "slack_thread", sourceUpdatedAt: "2026-09-21T10:00:00.000Z",
      body: "Thread a: we decided to ship\n\nSlack channel: C111",
      permalink: "https://app.slack.com/client/T999/C111/thread/C111-1727000000.000100",
    });
    expect(await harness.repository.listDocumentRefs(connectorScope, threadId("a"))).toEqual([{ kind: "channel", value: "T999/C111" }]);
    expect((await harness.repository.getDocument(connectorScope, threadId("g")))!.title).toBe("Slack thread");
    const everyChannel = await run(capturer, { companyScopeId: COMPANY, channelIds: [] });
    expect(everyChannel.counts).toMatchObject({ written: 1, unchanged: 2, deleted: 0 });
  });

  it("sweeps threads deleted in the Company Brain only after a complete read", async () => {
    harness = await connectorHarness("slack_bridge");
    let documents = [capture("a"), capture("bb"), capture("x".repeat(1_001))];
    let truncated = false;
    const { capture: capturer } = reader(() => ({ status: "ok", truncated, documents }));
    await run(capturer);
    documents = [capture("a")];
    truncated = true;
    expect((await run(capturer)).counts.deleted).toBe(0);
    truncated = false;
    const manual = capture("m", "C111", { provenance: "manually_published", permalink: "https://docs.example.com/x" });
    documents = [capture("a"), manual, capture("dm", "D123"), { ...manual, sourceId: "not a capture" }];
    expect((await run(capturer)).counts.deleted).toBe(2);
    expect(await harness.liveIds()).toEqual([threadId("a")]);
    documents = Array.from({ length: 1_001 }, (_, index) => capture(`n${index}`));
    expect((await run(capturer, config, { pagesPerRun: 1 })).counts.deleted).toBe(0);
  });

  it("re-renders in bounded steps after a settings change and resumes where it stopped", async () => {
    harness = await connectorHarness("slack_bridge");
    const seeds = ["a", "bb", "ccc", "dddd", "eeeee"];
    const { capture: capturer } = reader(() => ({ status: "ok", truncated: false, documents: seeds.map((seed) => capture(seed)) }));
    const step = { upsertsPerPage: 2, pagesPerRun: 1 };
    const counts = [];
    for (let index = 0; index < 4; index += 1) counts.push((await run(capturer, config, step)).counts.read);
    expect(counts).toEqual([2, 2, 1, 0]);
    const other = { companyScopeId: COMPANY, channelIds: ["C111", "C333"] };
    const migrated = [];
    for (let index = 0; index < 3; index += 1) migrated.push(await run(capturer, other, step));
    expect(migrated.map((result) => [result.counts.read, result.counts.unchanged, result.caughtUp]))
      .toEqual([[2, 2, false], [2, 2, false], [1, 1, true]]);
  });

  it("removes every copied thread when the owner loses the company scope, then fails the run", async () => {
    harness = await connectorHarness("slack_bridge");
    let status: "ok" | "forbidden" | "not_found" = "ok";
    const documents = [capture("a"), capture("bb"), capture("ccc")];
    const { capture: capturer } = reader(() => (status === "ok" ? { status, truncated: false, documents } : { status }));
    await run(capturer);
    expect(await harness.liveIds()).toHaveLength(3);
    status = "forbidden";
    const lost = await run(capturer, config, { upsertsPerPage: 2 });
    expect([lost.errorCode, lost.counts.deleted, await harness.liveIds()]).toEqual(["auth_failed", 3, []]);
    status = "not_found";
    expect((await run(capturer)).errorCode).toBe("remote_not_found");
  });

  it("maps capture outcomes and timeouts and is not configured without a reader", async () => {
    harness = await connectorHarness("slack_bridge");
    const codes = [];
    for (const status of ["forbidden", "not_found", "unavailable"] as const) {
      codes.push((await run(reader(() => ({ status })).capture)).errorCode);
    }
    expect(codes).toEqual(["auth_failed", "remote_not_found", "provider_unavailable"]);
    const ignoring = reader(() => new Promise<BrainSlackCaptureOutcome>(() => undefined)).capture;
    expect((await run(ignoring, config, {}, 1)).errorCode).toBe("provider_timeout");
    const handler = createBrainSlackBridgeHandler({ kysely: harness.db });
    expect(await handler.availability("owner_a")).toEqual({ available: false, reason: "not_configured" });
    expect(await handler.createAdapter("owner_a", connectorProject, config)).toEqual({ ok: false, code: "not_connected" });
    expect(handler.listOptions).toBeUndefined();
    const configured = createBrainSlackBridgeHandler({ kysely: harness.db, capture: reader(() => ({ status: "unavailable" })).capture });
    expect(await configured.availability("owner_a")).toEqual({ available: true });
  });
});

/**
 * Slack bridge source: copies the Slack threads that the Company Brain (company_brain_*, PR #2078) captured from
 * approved company channels into this project's brain. It reads through BrainSlackCaptureReader only (owner
 * authority, at most 1,000 documents per read) and never imports company-brain/. Only `slack_thread` documents whose
 * permalink names an allowed C or G channel are copied; other documents are left out without stopping the sweep, and
 * a complete read sweeps threads that were deleted there. Only an unreadable `slack_thread` makes a read incomplete.
 * When the owner can no longer read the company scope, every copied thread is swept and the run then fails.
 */
import { z } from "zod/v4";
import type { BrainSlackBridgeSourceConfig, BrainSourceAdapter, BrainSourceNotice } from "../../contracts.js";
import { failure, withCallTimeout, type ConnectorResult } from "./provider.js";
import { createSnapshotAdapter, type SnapshotItem, type SnapshotListing } from "./snapshot.js";
import { RefSet, canonicalPermalink, clampTitle, composeBody, connectorDocumentId, isoInstant, shortHash } from "./text.js";
import { BRAIN_CONNECTOR_LIMITS, type BrainSlackCaptureDocument, type BrainSlackCaptureReader } from "./types.js";

const RENDER_VERSION = "1";
/** The capture permalink: https://app.slack.com/client/<team>/<channel>/thread/<channel>-<ts>. */
const SLACK_THREAD_LINK = /^https:\/\/app\.slack\.com\/client\/(T[A-Z0-9]{2,63})\/([CG][A-Z0-9]{2,63})\/thread\//;

const CaptureSchema = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().max(300), text: z.string().max(65_536),
  permalink: z.string().max(2_048), provenance: z.string().max(64), sourceUpdatedAt: z.string().max(64),
  updatedAt: z.string().max(64),
});

interface ThreadItem extends SnapshotItem {
  readonly title: string; readonly text: string; readonly permalink: string; readonly teamId: string; readonly channelId: string;
}

async function listThreads(
  reader: BrainSlackCaptureReader, ownerId: string, timeoutMs: number, signal: AbortSignal, externalRef: string,
  config: BrainSlackBridgeSourceConfig,
): Promise<ConnectorResult<SnapshotListing<ThreadItem>>> {
  const read = await withCallTimeout(signal, timeoutMs, (callSignal) => reader.readThreads(
    ownerId, config.companyScopeId, BRAIN_CONNECTOR_LIMITS.slackThreadsMax, callSignal,
  ));
  if (!read.ok) return read;
  const outcome = read.value;
  if (outcome.status === "forbidden" || outcome.status === "not_found") {
    // The owner lost the company scope (or it is gone): copied threads leave this brain, then the run fails.
    const code = outcome.status === "forbidden" ? "auth_failed" : "remote_not_found";
    return { ok: true, value: { items: [], complete: true, gone: [], notices: [], revoked: { ok: false, code } } };
  }
  if (outcome.status !== "ok") return failure("provider_unavailable");
  const allowed = new Set(config.channelIds);
  const items: ThreadItem[] = [];
  const notices: BrainSourceNotice[] = outcome.truncated ? ["items_truncated"] : [];
  let complete = !outcome.truncated;
  for (const raw of outcome.documents.slice(0, BRAIN_CONNECTOR_LIMITS.slackThreadsMax)) {
    if ((raw as Partial<BrainSlackCaptureDocument> | null)?.provenance !== "slack_thread") continue;
    const parsed = CaptureSchema.safeParse(raw);
    const stamp = parsed.success ? isoInstant(parsed.data.updatedAt) : null;
    if (!parsed.success || stamp === null) {
      complete = false;
      continue;
    }
    const capture = parsed.data;
    const link = SLACK_THREAD_LINK.exec(capture.permalink);
    if (link === null || (allowed.size > 0 && !allowed.has(link[2]!))) continue;
    items.push({
      documentId: connectorDocumentId("slack_bridge", externalRef, ["thread", capture.sourceId]), stamp,
      title: capture.title, text: capture.text, permalink: capture.permalink, teamId: link[1]!, channelId: link[2]!,
    });
  }
  if (outcome.documents.length > BRAIN_CONNECTOR_LIMITS.slackThreadsMax) complete = false;
  return { ok: true, value: { items, complete, gone: [], notices } };
}

export function slackBridgeFingerprint(config: BrainSlackBridgeSourceConfig): string {
  return shortHash(["slack_bridge", RENDER_VERSION, config.companyScopeId, ...[...config.channelIds].sort()]);
}

export function createSlackBridgeAdapter(
  reader: BrainSlackCaptureReader, ownerId: string, timeoutMs: number, config: BrainSlackBridgeSourceConfig,
): BrainSourceAdapter<BrainSlackBridgeSourceConfig> {
  return createSnapshotAdapter<BrainSlackBridgeSourceConfig, ThreadItem>({
    kind: "slack_bridge", cursorPrefix: "sb1", fingerprint: slackBridgeFingerprint(config),
    buildsPerPage: BRAIN_CONNECTOR_LIMITS.slackThreadsMax, sweep: true,
    list: (context) => listThreads(reader, ownerId, timeoutMs, context.signal, context.externalRef, context.config),
    async build(item) {
      const title = clampTitle(item.title, "Slack thread");
      const composed = composeBody(title, item.text, [`Slack channel: ${item.channelId}`]);
      return {
        ok: true,
        value: {
          upsert: {
            documentId: item.documentId, title, body: composed.body, permalink: canonicalPermalink(item.permalink),
            sourceUpdatedAt: item.stamp, provenance: "slack_thread",
            refs: new RefSet().add("channel", `${item.teamId}/${item.channelId}`).list(),
          },
          notices: composed.truncated ? ["body_truncated"] : [],
        },
      };
    },
  });
}

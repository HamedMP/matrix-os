/**
 * Google Drive source: Google Docs in the configured folders (and their subfolders, two levels down), exported as
 * plain text through the integration layer (registry actions google_drive.brain_list_folder and
 * google_drive.brain_export_text) and cut to the store limit. Other file types, and files the owner may not
 * download, are not read. An export refused (a 403 too: the listing with the same account just worked), unreadable
 * or over the size cap is a skipped item (too_large_skipped) that the next run tries again. A complete listing sweeps
 * documents whose file left the folders; a capped listing sweeps nothing.
 */
import { z } from "zod/v4";
import {
  BRAIN_INTEGRATION_RESPONSE_MAX_BYTES, type BrainGoogleDriveSourceConfig, type BrainSourceAdapter,
  type BrainSourceErrorCode, type BrainSourceNotice,
} from "../../contracts.js";
import { callProvider, text, type ConnectorResult, type ProviderCall as Call } from "./provider.js";
import { createSnapshotAdapter, type SnapshotItem, type SnapshotListing } from "./snapshot.js";
import {
  RefSet, canonicalPermalink, clampTitle, composeBody, connectorDocumentId, isoInstant, personKey, shortHash,
} from "./text.js";
import { BRAIN_CONNECTOR_LIMITS } from "./types.js";

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_DOC_MIME = "application/vnd.google-apps.document";
const RENDER_VERSION = "1";
/** Export failures that concern one file (refused or forbidden, unreadable output, over the caller's size cap). */
const SKIPPED_EXPORT_CODES: readonly BrainSourceErrorCode[] = [
  "auth_failed", "config_invalid", "provider_output_invalid", "provider_unavailable",
];

const DriveFileSchema = z.object({
  id: z.string().min(1).max(256), name: text(1_000), mimeType: text(256), modifiedTime: text(64).optional(),
  webViewLink: text(2_048).nullable().optional(),
  lastModifyingUser: z.object({ emailAddress: text(320).nullable().optional() }).nullable().optional(),
  capabilities: z.object({ canDownload: z.boolean().optional() }).nullable().optional(),
});
const DriveListSchema = z.object({
  files: z.array(DriveFileSchema).max(1_000),
  nextPageToken: text(2_048).nullable().optional(),
  incompleteSearch: z.boolean().optional(),
});
const ExportSchema = z.string().max(BRAIN_INTEGRATION_RESPONSE_MAX_BYTES);

interface DriveItem extends SnapshotItem {
  readonly fileId: string;
  readonly name: string;
  readonly link: string | null;
  readonly editor: string | null;
}

async function listFolders(
  call: Call, signal: AbortSignal, externalRef: string, config: BrainGoogleDriveSourceConfig,
): Promise<ConnectorResult<SnapshotListing<DriveItem>>> {
  const limits = BRAIN_CONNECTOR_LIMITS;
  const queue = config.folderIds.map((folderId) => ({ folderId, depth: 0 }));
  const visited = new Set<string>();
  const items = new Map<string, DriveItem>();
  const notices: BrainSourceNotice[] = [];
  let complete = true;
  let calls = 0;
  folders: for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (visited.has(next.folderId)) continue;
    if (visited.size >= limits.driveFoldersMax) {
      complete = false;
      notices.push("items_truncated");
      break;
    }
    visited.add(next.folderId);
    let pageToken: string | null = null;
    do {
      if (calls >= limits.listCallsMax) {
        complete = false;
        notices.push("pages_capped");
        break folders;
      }
      calls += 1;
      const listed: ConnectorResult<z.output<typeof DriveListSchema>> = await callProvider({ ...call, signal }, {
        service: "google_drive", action: "brain_list_folder",
        ...(config.accountLabel === undefined ? {} : { label: config.accountLabel }),
        params: { folderId: next.folderId, pageSize: limits.drivePageSize, ...(pageToken === null ? {} : { pageToken }) },
      }, DriveListSchema);
      if (!listed.ok) return listed;
      if (listed.value.incompleteSearch === true) complete = false;
      for (const file of listed.value.files) {
        if (file.mimeType === DRIVE_FOLDER_MIME) {
          if (next.depth < limits.driveDepthMax) queue.push({ folderId: file.id, depth: next.depth + 1 });
          continue;
        }
        const stamp = isoInstant(file.modifiedTime);
        if (file.mimeType !== DRIVE_DOC_MIME || stamp === null || file.capabilities?.canDownload === false) continue;
        const documentId = connectorDocumentId("google_drive", externalRef, ["file", file.id]);
        if (items.has(documentId)) continue;
        if (items.size >= limits.driveFilesMax) {
          complete = false;
          notices.push("items_truncated");
          break folders;
        }
        items.set(documentId, {
          documentId, stamp, fileId: file.id, name: file.name, link: file.webViewLink ?? null,
          editor: file.lastModifyingUser?.emailAddress ?? null,
        });
      }
      pageToken = listed.value.nextPageToken ?? null;
    } while (pageToken !== null);
  }
  return { ok: true, value: { items: [...items.values()], complete, gone: [], notices } };
}

export function driveFingerprint(config: BrainGoogleDriveSourceConfig): string {
  return shortHash(["google_drive", RENDER_VERSION, ...[...config.folderIds].sort()]);
}

export function createGoogleDriveAdapter(
  call: Call, config: BrainGoogleDriveSourceConfig,
): BrainSourceAdapter<BrainGoogleDriveSourceConfig> {
  return createSnapshotAdapter<BrainGoogleDriveSourceConfig, DriveItem>({
    kind: "google_drive", cursorPrefix: "gd1", fingerprint: driveFingerprint(config),
    buildsPerPage: BRAIN_CONNECTOR_LIMITS.driveExportsPerPage, sweep: true,
    list: (context) => listFolders(call, context.signal, context.externalRef, context.config),
    async build(item, context) {
      const exported = await callProvider({ ...call, signal: context.signal }, {
        service: "google_drive", action: "brain_export_text",
        ...(context.config.accountLabel === undefined ? {} : { label: context.config.accountLabel }),
        params: { fileId: item.fileId },
      }, ExportSchema);
      if (!exported.ok && SKIPPED_EXPORT_CODES.includes(exported.code)) {
        return { ok: true, value: { upsert: null, notices: ["too_large_skipped"] } };
      }
      if (!exported.ok) return exported;
      const title = clampTitle(item.name, "Untitled document");
      const composed = composeBody(title, exported.value, [`Google Doc: ${title}`, `Modified: ${item.stamp}`]);
      return {
        ok: true,
        value: {
          upsert: {
            documentId: item.documentId, title, body: composed.body, permalink: canonicalPermalink(item.link),
            sourceUpdatedAt: item.stamp, provenance: "google_doc",
            refs: new RefSet().add("author", personKey("email", item.editor)).list(),
          },
          notices: composed.truncated ? ["body_truncated"] : [],
        },
      };
    },
  });
}

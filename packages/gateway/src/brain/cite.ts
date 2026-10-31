/**
 * The one cite rule (contracts/common.ts BrainCiteView) for every feature that shows a document. label: git_pr and
 * git_commit read the git footer ("#N" or "!N" when it names one, else the first 12 hex of its sha; "PR" or "commit"
 * only when there is no footer); then the document's handle ref; then a git_spec's first spec ref; else the title.
 * Cut to BRAIN_CITE_LABEL_MAX_CHARS without splitting a surrogate pair. loadBrainCites reads live documents only.
 */
import { sql, type QueryExecutorProvider } from "kysely";
import {
  BRAIN_CITE_LABEL_MAX_CHARS, BRAIN_PROVENANCE_CITE_KINDS, type BrainCiteKind, type BrainCiteView,
  type BrainProvenance,
} from "./contracts.js";
import { asIso } from "./mappers.js";
import type { BrainScopeKey } from "./types.js";
import { parseBrainGitFooter } from "./why.js";

export const BRAIN_CITE_SHORT_SHA_CHARS = 12;
/** The body end read for a git footer. */
export const BRAIN_CITE_TAIL_CHARS = 2_048;
const CITE_BATCH = 500;

export interface BrainCiteInput {
  readonly documentId: string; readonly provenance: string; readonly sourceId: string | null;
  readonly title: string; readonly permalink: string; readonly date: Date | string; readonly revision: number;
  /** The body end of a git_pr or git_commit (its footer); ignored for other provenances. */
  readonly bodyTail: string | null;
  readonly handle: string | null; readonly spec: string | null;
}

export function brainCiteKind(provenance: string): BrainCiteKind {
  return Object.hasOwn(BRAIN_PROVENANCE_CITE_KINDS, provenance)
    ? BRAIN_PROVENANCE_CITE_KINDS[provenance as BrainProvenance] : "document";
}

function cut(label: string): string {
  const max = BRAIN_CITE_LABEL_MAX_CHARS;
  if (label.length <= max) return label;
  const unit = label.charCodeAt(max - 1);
  return label.slice(0, unit >= 0xd800 && unit <= 0xdbff ? max - 1 : max);
}

export function brainCiteLabel(
  input: Pick<BrainCiteInput, "provenance" | "title" | "bodyTail" | "handle" | "spec">,
): string {
  const { provenance } = input;
  if (provenance === "git_pr" || provenance === "git_commit") {
    const footer = input.bodyTail === null ? null : parseBrainGitFooter(input.bodyTail);
    if (footer === null) return provenance === "git_pr" ? "PR" : "commit";
    return cut(footer.number !== null && footer.sigil !== null
      ? `${footer.sigil}${footer.number}` : footer.sha.slice(0, BRAIN_CITE_SHORT_SHA_CHARS));
  }
  return cut(input.handle ?? (provenance === "git_spec" ? input.spec : null) ?? input.title);
}

export function brainCite(input: BrainCiteInput): BrainCiteView {
  return {
    documentId: input.documentId, kind: brainCiteKind(input.provenance), provenance: input.provenance,
    sourceId: input.sourceId, label: brainCiteLabel(input), title: input.title, permalink: input.permalink,
    date: asIso(input.date), revision: input.revision,
  };
}

interface CiteRow {
  readonly document_id: string; readonly provenance: string; readonly source_id: string | null;
  readonly title: string; readonly permalink: string; readonly source_updated_at: Date | string;
  readonly revision: number; readonly body_tail: string | null; readonly handle: string | null;
  readonly spec: string | null;
}

/** Cites of the live documents among `documentIds`, one query per 500 ids; tombstoned or unknown ids are absent. */
export async function loadBrainCites(
  db: QueryExecutorProvider, scope: BrainScopeKey, documentIds: readonly string[],
): Promise<Map<string, BrainCiteView>> {
  const unique = [...new Set(documentIds)];
  const cites = new Map<string, BrainCiteView>();
  for (let start = 0; start < unique.length; start += CITE_BATCH) {
    const ids = unique.slice(start, start + CITE_BATCH);
    const ref = (kind: string) => sql<string | null>`(SELECT min(r.value) FROM brain_document_refs r
      WHERE r.owner_id = d.owner_id AND r.scope_id = d.scope_id AND r.document_id = d.document_id
        AND r.kind = ${kind})`;
    const { rows } = await sql<CiteRow>`
      SELECT d.document_id, d.provenance, d.source_id, d.title, d.permalink, d.source_updated_at, d.revision,
        CASE WHEN d.provenance IN ('git_pr', 'git_commit')
          THEN right(d.body, ${BRAIN_CITE_TAIL_CHARS}::int) ELSE NULL END AS body_tail,
        ${ref("handle")} AS handle, ${ref("spec")} AS spec
      FROM brain_documents d
      WHERE d.owner_id = ${scope.ownerId} AND d.scope_id = ${scope.scopeId} AND d.deleted_at IS NULL
        AND d.document_id IN (${sql.join(ids)})`.execute(db);
    for (const row of rows) {
      cites.set(row.document_id, brainCite({
        documentId: row.document_id, provenance: row.provenance, sourceId: row.source_id, title: row.title,
        permalink: row.permalink, date: row.source_updated_at, revision: row.revision, bodyTail: row.body_tail,
        handle: row.handle, spec: row.spec,
      }));
    }
  }
  return cites;
}

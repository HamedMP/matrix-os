/**
 * Sources service: client views of sources, receipts and sync runs, and the git sync mapped onto the /sources sync
 * view. Pure. Views carry no cursor, path outside a config view, rejected id or provider text.
 */
import type { BrainProjectService, BrainReceiptView, BrainSyncView } from "../../api/types.js";
import type {
  BrainSourceConfigView, BrainSourceErrorCode, BrainSourceInfoCode, BrainSourceKind, BrainSourceLastSyncView,
  BrainSourceNotice, BrainSourcesServiceDeps, BrainSourceSyncResult, BrainSourceSyncView, BrainSourceView,
} from "../../contracts.js";
import type { GitSyncErrorCode, GitSyncInfoCode, GitSyncNotice } from "../../git/types.js";
import type { BrainSource, BrainSyncReceipt } from "../../types.js";

export function toReceiptView(receipt: BrainSyncReceipt): BrainReceiptView {
  const { receiptId, status, counts, nextAction, errorCode, startedAt, finishedAt } = receipt;
  return { receiptId, status, counts, nextAction, errorCode, startedAt, finishedAt };
}

export function toLastSyncView(receipt: BrainSyncReceipt | undefined): BrainSourceLastSyncView | null {
  if (receipt === undefined) return null;
  const { status, startedAt, finishedAt, nextAction, errorCode } = receipt;
  return { status, startedAt, finishedAt, nextAction, errorCode };
}

/** externalRef is a repository identity only for git and github; other kinds' refs are internal hashes. */
export function toSourceView(
  source: BrainSource & { readonly kind: BrainSourceKind }, config: BrainSourceConfigView | null,
  lastSync: BrainSourceLastSyncView | null,
): BrainSourceView {
  const { sourceId, kind, label, status, revision, createdAt, updatedAt } = source;
  const externalRef = kind === "git" || kind === "github" ? source.externalRef : null;
  return { sourceId, kind, label, externalRef, status, revision, createdAt, updatedAt, config, lastSync };
}

export function toSourceSyncView(sourceId: string, result: BrainSourceSyncResult): BrainSourceSyncView {
  const { status, errorCode, nextAction, caughtUp, pages, counts, notices, retryAfterSeconds } = result;
  const receipt = result.receipt === null ? null : toReceiptView(result.receipt);
  return { sourceId, status, errorCode, nextAction, caughtUp, pages, counts, notices, retryAfterSeconds, receipt };
}

type GitOnlyCode = Exclude<GitSyncErrorCode | GitSyncInfoCode, BrainSourceErrorCode | BrainSourceInfoCode>;

/** Git codes outside the source vocabulary; the receipt keeps the git code itself. history_rewritten is no failure. */
const GIT_ERROR_CODES: Readonly<Record<GitOnlyCode, BrainSourceErrorCode | null>> = {
  git_unavailable: "provider_unavailable", git_version_unsupported: "provider_unavailable",
  git_command_failed: "provider_unavailable", git_timeout: "provider_timeout",
  git_output_too_large: "provider_output_invalid", git_output_malformed: "provider_output_invalid",
  not_a_repository: "config_invalid", shallow_repository: "config_invalid", branch_unavailable: "config_invalid",
  web_base_unavailable: "config_invalid", remote_mismatch: "config_invalid", history_rewritten: null,
};
const GIT_NOTICES: Readonly<Record<GitSyncNotice, BrainSourceNotice | null>> = {
  run_budget_exhausted: "run_budget_exhausted", message_truncated: "body_truncated", paths_truncated: "items_truncated",
  invalid_paths_dropped: "items_truncated", spec_files_capped: "items_truncated", spec_file_oversize: "too_large_skipped",
  spec_file_not_text: "binary_skipped", history_rewritten: null,
};

function isGitOnlyCode(code: GitSyncErrorCode | GitSyncInfoCode): code is GitOnlyCode {
  return Object.hasOwn(GIT_ERROR_CODES, code);
}

function gitErrorCode(code: BrainSyncView["errorCode"]): BrainSourceSyncView["errorCode"] {
  if (code === null) return null;
  return isGitOnlyCode(code) ? GIT_ERROR_CODES[code] : code;
}

/** A git sync view as a /sources sync view. sourceId: the source the client asked to sync. */
export function gitSyncToSourceView(sourceId: string, view: BrainSyncView): BrainSourceSyncView {
  const notices: BrainSourceNotice[] = [];
  for (const notice of view.notices) {
    const mapped = GIT_NOTICES[notice];
    if (mapped !== null && !notices.includes(mapped)) notices.push(mapped);
  }
  return {
    sourceId, status: view.status, errorCode: gitErrorCode(view.errorCode), nextAction: view.nextAction,
    caughtUp: view.caughtUp, pages: view.receipt === null ? 0 : 1, counts: view.counts, notices,
    retryAfterSeconds: null, receipt: view.receipt,
  };
}

/**
 * BrainSourcesServiceDeps.gitSync over the project service (pass the wrapped one that emits documents_changed). The
 * view's sourceId is empty here; the sources service sets it to the source the client named.
 */
export function createBrainGitSourceSync(
  project: Pick<BrainProjectService, "sync">,
): NonNullable<BrainSourcesServiceDeps["gitSync"]> {
  return async (ownerId, projectRef, run) => gitSyncToSourceView("", await project.sync(ownerId, projectRef, run));
}

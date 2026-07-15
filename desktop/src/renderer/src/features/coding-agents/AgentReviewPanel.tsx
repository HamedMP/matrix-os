import { Bot, ChevronRight, ClipboardCheck, ExternalLink, FileText, FolderOpen, GitCommitHorizontal, GitPullRequest, Save, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  defaultAgentThreadComposerDraft,
  type AgentThreadComposerDraft,
  type FileBrowseResponse,
  type FileReadRequest,
  type FileReadResponse,
  type FileSearchResponse,
  type ReviewSnapshot,
  type RuntimeSummary,
  type SourceControlCreatePullRequestRequest,
  type SourceControlCreatePullRequestResponse,
  type SourceControlPrepareCommitRequest,
} from "@matrix-os/contracts";
import { Button } from "../../design/primitives";
import { invoke } from "../../lib/operator";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { AgentWorkspaceSection as Section } from "./AgentWorkspaceSection";
import {
  formatHunkRange,
  ReviewDiffLines,
  reviewStatusLabel,
  type ReviewSnapshotFile,
  type ReviewSnapshotHunk,
} from "./AgentReviewDiff";

type ReviewDetailStatus = "idle" | "loading" | "ready" | "error";
type FileBrowserStatus = "idle" | "loading" | "ready" | "error";
type FileReadStatus = "idle" | "loading" | "ready" | "error";
type FileWriteStatus = "idle" | "saving" | "saved" | "error";
type SelectedReviewHunk = {
  key: string;
  file: ReviewSnapshotFile;
  hunk: ReviewSnapshotHunk;
  hunkIndex: number;
};

function canOpenPreviewExternally(origin: string | undefined): origin is string {
  if (!origin) return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

export function ReviewList({
  canReadFiles,
  canPrepareCommit,
  canCreateFollowUp,
  onAskHunkFollowUp,
}: {
  canReadFiles: boolean;
  canPrepareCommit: boolean;
  canCreateFollowUp: boolean;
  onAskHunkFollowUp: (snapshot: ReviewSnapshot, selected: SelectedReviewHunk) => void;
}) {
  const reviewsStatus = useCodingAgentWorkspace((s) => s.reviewsStatus);
  const reviews = useCodingAgentWorkspace((s) => s.reviews);
  const reviewsError = useCodingAgentWorkspace((s) => s.reviewsError);
  const selectedReviewId = useCodingAgentWorkspace((s) => s.selectedReviewId);
  const reviewSnapshotStatus = useCodingAgentWorkspace((s) => s.reviewSnapshotStatus);
  const reviewSnapshot = useCodingAgentWorkspace((s) => s.reviewSnapshot);
  const reviewSnapshotError = useCodingAgentWorkspace((s) => s.reviewSnapshotError);
  const fileReadStatus = useCodingAgentWorkspace((s) => s.fileReadStatus);
  const fileRead = useCodingAgentWorkspace((s) => s.fileRead);
  const fileReadError = useCodingAgentWorkspace((s) => s.fileReadError);
  const fileWriteStatus = useCodingAgentWorkspace((s) => s.fileWriteStatus);
  const fileWriteError = useCodingAgentWorkspace((s) => s.fileWriteError);
  const sourceCommitStatus = useCodingAgentWorkspace((s) => s.sourceCommitStatus);
  const sourceCommitError = useCodingAgentWorkspace((s) => s.sourceCommitError);
  const sourcePullRequestStatus = useCodingAgentWorkspace((s) => s.sourcePullRequestStatus);
  const sourcePullRequest = useCodingAgentWorkspace((s) => s.sourcePullRequest);
  const sourcePullRequestError = useCodingAgentWorkspace((s) => s.sourcePullRequestError);
  const selectedFilePath = useCodingAgentWorkspace((s) => s.selectedFilePath);
  const selectReview = useCodingAgentWorkspace((s) => s.selectReview);
  const loadFileContent = useCodingAgentWorkspace((s) => s.loadFileContent);
  const saveFileContent = useCodingAgentWorkspace((s) => s.saveFileContent);
  const prepareSourceCommit = useCodingAgentWorkspace((s) => s.prepareSourceCommit);
  const createSourcePullRequest = useCodingAgentWorkspace((s) => s.createSourcePullRequest);
  const items = reviews?.items ?? [];

  return (
    <Section title="Review" count={items.length}>
      <div className="grid gap-3">
        {reviewsStatus === "error" ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
            {reviewsError ?? "Review state unavailable"}
          </p>
        ) : null}
        {items.map((review) => (
          <button
            key={review.id}
            type="button"
            aria-label={`Open review PR #${review.pullRequestNumber}`}
            className="no-drag flex min-h-[68px] w-full items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors duration-100 hover:brightness-105"
            onClick={() => void selectReview(review.id)}
            style={{
              borderColor: selectedReviewId === review.id ? "var(--accent)" : "var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <ClipboardCheck size={15} style={{ color: "var(--text-tertiary)" }} />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {review.projectId}
                </h3>
                <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {`PR #${review.pullRequestNumber} - Round ${review.round} of ${review.maxRounds}`}
                </p>
              </div>
            </div>
            <div className="shrink-0 text-right text-xs" style={{ color: "var(--text-secondary)" }}>
              <p className="capitalize">{reviewStatusLabel(review.status)}</p>
              {review.findings ? (
                <p style={{ color: review.findings.high > 0 ? "var(--danger)" : "var(--text-tertiary)" }}>
                  {review.findings.high} high
                </p>
              ) : null}
            </div>
            <ChevronRight size={15} style={{ color: "var(--text-tertiary)" }} />
          </button>
        ))}
        <ReviewSnapshotPanel
          status={reviewSnapshotStatus}
          snapshot={reviewSnapshot}
          error={reviewSnapshotError}
          canReadFiles={canReadFiles}
          fileReadStatus={fileReadStatus}
          fileRead={fileRead}
          fileReadError={fileReadError}
          fileWriteStatus={fileWriteStatus}
          fileWriteError={fileWriteError}
          sourceCommitStatus={sourceCommitStatus}
          sourceCommitError={sourceCommitError}
          sourcePullRequestStatus={sourcePullRequestStatus}
          sourcePullRequest={sourcePullRequest}
          sourcePullRequestError={sourcePullRequestError}
          selectedFilePath={selectedFilePath}
          onOpenFile={loadFileContent}
          onSaveFile={saveFileContent}
          canPrepareCommit={canPrepareCommit}
          onPrepareCommit={prepareSourceCommit}
          onCreatePullRequest={createSourcePullRequest}
          canCreateFollowUp={canCreateFollowUp}
          onAskHunkFollowUp={onAskHunkFollowUp}
        />
        {reviewsStatus !== "error" && reviewsStatus !== "loading" && items.length === 0 ? (
          <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            No reviews.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function ReviewSnapshotPanel({
  status,
  snapshot,
  error,
  canReadFiles,
  fileReadStatus,
  fileRead,
  fileReadError,
  fileWriteStatus,
  fileWriteError,
  sourceCommitStatus,
  sourceCommitError,
  sourcePullRequestStatus,
  sourcePullRequest,
  sourcePullRequestError,
  selectedFilePath,
  onOpenFile,
  onSaveFile,
  canPrepareCommit,
  onPrepareCommit,
  onCreatePullRequest,
  canCreateFollowUp,
  onAskHunkFollowUp,
}: {
  status: ReviewDetailStatus;
  snapshot: ReviewSnapshot | null;
  error: string | null;
  canReadFiles: boolean;
  fileReadStatus: FileReadStatus;
  fileRead: FileReadResponse | null;
  fileReadError: string | null;
  fileWriteStatus: FileWriteStatus;
  fileWriteError: string | null;
  sourceCommitStatus: "idle" | "preparing" | "prepared" | "error";
  sourceCommitError: string | null;
  sourcePullRequestStatus: "idle" | "creating" | "ready" | "error";
  sourcePullRequest: SourceControlCreatePullRequestResponse | null;
  sourcePullRequestError: string | null;
  selectedFilePath: string | null;
  onOpenFile: (request: FileReadRequest) => void;
  onSaveFile: (request: { projectId: string; worktreeId: string; path: string; content: string; baseEtag: string | null }) => void;
  canPrepareCommit: boolean;
  onPrepareCommit: (request: Omit<SourceControlPrepareCommitRequest, "clientRequestId">) => void;
  onCreatePullRequest: (request: Omit<SourceControlCreatePullRequestRequest, "clientRequestId">) => void;
  canCreateFollowUp: boolean;
  onAskHunkFollowUp: (snapshot: ReviewSnapshot, selected: SelectedReviewHunk) => void;
}) {
  const [selectedHunkKey, setSelectedHunkKey] = useState<string | null>(null);
  const selectedHunk = useMemo(() => {
    if (!snapshot || !selectedHunkKey) return null;
    for (const [fileIndex, file] of snapshot.files.items.entries()) {
      for (const [hunkIndex, hunk] of file.hunks.entries()) {
        const key = reviewHunkKey(fileIndex, file, hunk, hunkIndex);
        if (key === selectedHunkKey) return { key, file, hunk, hunkIndex };
      }
    }
    return null;
  }, [selectedHunkKey, snapshot]);

  useEffect(() => {
    setSelectedHunkKey(null);
  }, [snapshot?.review.id, snapshot?.updatedAt]);

  if (status === "idle") return null;
  if (status === "loading") {
    return (
      <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
        Loading review details...
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
        {error ?? "Review details unavailable"}
      </p>
    );
  }
  if (!snapshot) return null;
  const prepareCommitPaths = snapshot.files.items.map((file) => file.path).slice(0, 100);
  const prepareCommitDisabled = sourceCommitStatus === "preparing" || prepareCommitPaths.length === 0;
  const createPullRequestDisabled = sourcePullRequestStatus === "creating";
  const sourcePullRequestUrl = canOpenPreviewExternally(sourcePullRequest?.url) ? sourcePullRequest.url : null;

  return (
    <article className="grid min-w-0 max-w-full gap-3 overflow-hidden rounded-md border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {`PR #${snapshot.review.pullRequestNumber} review details`}
          </h3>
          <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
            {`${snapshot.files.items.length} files${snapshot.partial ? " - partial" : ""}`}
          </p>
        </div>
        <span className="shrink-0 text-xs capitalize" style={{ color: "var(--text-secondary)" }}>
          {reviewStatusLabel(snapshot.review.status)}
        </span>
      </div>
      {canPrepareCommit ? (
        <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
          {sourceCommitStatus === "prepared" ? (
            <span className="text-xs" style={{ color: "var(--success)" }}>
              Commit prepared
            </span>
          ) : null}
          {sourceCommitStatus === "error" ? (
            <span className="text-xs" style={{ color: "var(--danger)" }}>
              {sourceCommitError ?? "Source commit could not be prepared. Refresh and try again."}
            </span>
          ) : null}
          {sourcePullRequestStatus === "ready" ? (
            <span className="text-xs" style={{ color: "var(--success)" }}>
              Pull request ready
            </span>
          ) : null}
          {sourcePullRequestStatus === "ready" && sourcePullRequestUrl ? (
            <Button
              variant="ghost"
              type="button"
              aria-label={`Open created pull request #${sourcePullRequest?.number}`}
              onClick={() => {
                void invoke("shell:open-external", { url: sourcePullRequestUrl }).catch(() => {
                  console.warn("[coding-agents] source pull request open failed");
                });
              }}
            >
              <ExternalLink size={14} />
              Open PR
            </Button>
          ) : null}
          {sourcePullRequestStatus === "error" ? (
            <span className="text-xs" style={{ color: "var(--danger)" }}>
              {sourcePullRequestError ?? "Pull request could not be created. Refresh and try again."}
            </span>
          ) : null}
          <Button
            variant="ghost"
            type="button"
            disabled={prepareCommitDisabled}
            aria-label={`Prepare commit for review PR #${snapshot.review.pullRequestNumber}`}
            onClick={() => onPrepareCommit({
              projectId: snapshot.review.projectId,
              worktreeId: snapshot.review.worktreeId,
              message: `fix: apply review updates for PR #${snapshot.review.pullRequestNumber}`,
              paths: prepareCommitPaths,
            })}
          >
            <GitCommitHorizontal size={14} />
            {sourceCommitStatus === "preparing" ? "Preparing" : "Prepare commit"}
          </Button>
          <Button
            variant="ghost"
            type="button"
            disabled={createPullRequestDisabled}
            aria-label={`Create pull request for review PR #${snapshot.review.pullRequestNumber}`}
            onClick={() => onCreatePullRequest({
              projectId: snapshot.review.projectId,
              worktreeId: snapshot.review.worktreeId,
              title: `fix: apply review updates for PR #${snapshot.review.pullRequestNumber}`,
              body: "Review updates are ready.",
            })}
          >
            <GitPullRequest size={14} />
            {sourcePullRequestStatus === "creating" ? "Creating" : "Create PR"}
          </Button>
        </div>
      ) : null}
      {snapshot.safeNotice ? (
        <p className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
          {snapshot.safeNotice}
        </p>
      ) : null}
      {canReadFiles ? (
        <ReviewFileBrowserPanel
          key={`${snapshot.review.projectId}:${snapshot.review.worktreeId}:${snapshot.review.id}:${snapshot.updatedAt}`}
          snapshot={snapshot}
          canReadFiles={canReadFiles}
          onOpenFile={onOpenFile}
        />
      ) : null}
      <div className="grid min-w-0 gap-2">
        {snapshot.files.items.map((file, fileIndex) => (
          <div
            key={`${file.path}:${fileIndex}`}
            className="grid min-w-0 gap-2 overflow-hidden rounded-md border px-3 py-2"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <FileText size={14} style={{ color: "var(--text-tertiary)" }} />
                <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>
                  {file.path}
                </span>
              </div>
              <span className="shrink-0 text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
                {file.status}
              </span>
            </div>
            {canReadFiles ? (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  type="button"
                  aria-label={`Open file ${file.path}`}
                  onClick={() => onOpenFile({
                    projectId: snapshot.review.projectId,
                    worktreeId: snapshot.review.worktreeId,
                    path: file.path,
                  })}
                >
                  <FileText size={14} />
                  Open file
                </Button>
              </div>
            ) : null}
            {selectedFilePath === file.path ? (
              <FileContentPanel
                status={fileReadStatus}
                file={fileRead}
                error={fileReadError}
                writeStatus={fileWriteStatus}
                writeError={fileWriteError}
                projectId={snapshot.review.projectId}
                worktreeId={snapshot.review.worktreeId}
                onSave={onSaveFile}
              />
            ) : null}
            {file.findings?.length ? (
              <div className="grid gap-1">
                {file.findings.map((finding) => (
                  <p key={finding.id} className="text-xs" style={{ color: finding.severity === "high" ? "var(--danger)" : "var(--text-secondary)" }}>
                    {finding.summary}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                No findings in this file.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded border px-2 py-1" style={{ borderColor: "var(--border-subtle)", color: "var(--success)" }}>
                +{file.additions}
              </span>
              <span className="rounded border px-2 py-1" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
                -{file.deletions}
              </span>
              {file.partial ? (
                <span className="rounded border px-2 py-1" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
                  Partial file
                </span>
              ) : null}
            </div>
            {file.hunks.length ? (
              <div className="grid gap-1">
                {file.hunks.map((hunk, hunkIndex) => {
                  const hunkKey = reviewHunkKey(fileIndex, file, hunk, hunkIndex);
                  const selected = selectedHunk?.key === hunkKey;
                  return (
                    <div
                      key={`${file.path}:${fileIndex}:${hunk.id}:${hunkIndex}`}
                      className="grid min-w-0 gap-1 overflow-hidden rounded-md border transition-colors duration-100"
                      style={{
                        borderColor: selected ? "var(--accent)" : "var(--border-subtle)",
                        background: selected ? "var(--accent-muted)" : "transparent",
                      }}
                    >
                      <button
                        type="button"
                        aria-label={`Select hunk ${hunkIndex + 1} in ${file.path}`}
                        aria-pressed={selected}
                        className="no-drag grid gap-1 rounded-md px-3 py-2 text-left transition-colors duration-100 hover:brightness-105"
                        onClick={() => setSelectedHunkKey(hunkKey)}
                        style={{ background: "transparent" }}
                      >
                        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                          {`Hunk ${hunkIndex + 1}`}
                        </span>
                        <span className="font-mono text-xs" style={{ color: "var(--text-primary)" }}>
                          {formatHunkRange(hunk)}
                        </span>
                        {hunk.partial ? (
                          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                            Partial hunk
                          </span>
                        ) : null}
                      </button>
                      <ReviewDiffLines lines={hunk.lines ?? []} />
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {selectedHunk ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            type="button"
            disabled={!canCreateFollowUp}
            onClick={() => onAskHunkFollowUp(snapshot, selectedHunk)}
            aria-label="Ask agent about selected hunk"
          >
            <Bot size={14} />
            Ask agent about selected hunk
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function ReviewFileBrowserPanel({
  snapshot,
  canReadFiles,
  onOpenFile,
}: {
  snapshot: ReviewSnapshot;
  canReadFiles: boolean;
  onOpenFile: (request: FileReadRequest) => void;
}) {
  const [browseStatus, setBrowseStatus] = useState<FileBrowserStatus>("idle");
  const [browse, setBrowse] = useState<FileBrowseResponse | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<FileBrowserStatus>("idle");
  const [searchResult, setSearchResult] = useState<FileSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const projectId = snapshot.review.projectId;
  const worktreeId = snapshot.review.worktreeId;

  async function loadBrowse(path?: string) {
    setBrowseStatus("loading");
    setBrowseError(null);
    try {
      const response = await invoke("runtime:browse-files", {
        projectId,
        worktreeId,
        ...(path ? { path } : {}),
        limit: 20,
      });
      setBrowse(response);
      setBrowseStatus("ready");
    } catch {
      console.warn("[coding-agents] file browse failed");
      setBrowse(null);
      setBrowseStatus("error");
      setBrowseError("File list unavailable");
    }
  }

  async function runSearch() {
    const query = searchQuery.trim();
    if (!query) return;
    setSearchStatus("loading");
    setSearchError(null);
    try {
      const response = await invoke("runtime:search-files", {
        projectId,
        worktreeId,
        query,
        limit: 20,
      });
      setSearchResult(response);
      setSearchStatus("ready");
    } catch {
      console.warn("[coding-agents] file search failed");
      setSearchResult(null);
      setSearchStatus("error");
      setSearchError("File search unavailable");
    }
  }

  const renderEntry = (
    entry: FileBrowseResponse["entries"]["items"][number],
    source: "browse" | "search",
  ) => {
    const isDirectory = entry.kind === "directory";
    const isFile = entry.kind === "file";
    return (
      <div
        key={`${source}:${entry.path}`}
        className="flex min-h-[42px] items-center justify-between gap-3 rounded-md border px-3 py-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}
      >
        <div className="flex min-w-0 items-center gap-2">
          {isDirectory ? (
            <FolderOpen size={14} style={{ color: "var(--text-tertiary)" }} />
          ) : (
            <FileText size={14} style={{ color: "var(--text-tertiary)" }} />
          )}
          <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>
            {entry.path}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
            {entry.kind}
          </span>
          {isDirectory ? (
            <Button
              variant="ghost"
              type="button"
              aria-label={`Open directory ${entry.path}`}
              onClick={() => void loadBrowse(entry.path)}
            >
              <FolderOpen size={14} />
              Open
            </Button>
          ) : null}
          {canReadFiles && isFile ? (
            <Button
              variant="ghost"
              type="button"
              aria-label={`Open file ${entry.path} from ${source === "search" ? "search results" : "file browser"}`}
              onClick={() => onOpenFile({ projectId, worktreeId, path: entry.path })}
            >
              <FileText size={14} />
              Open
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="grid min-w-0 gap-2 overflow-hidden rounded-md border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            File browser
          </h4>
          <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
            {`${projectId} / ${worktreeId}`}
          </p>
        </div>
        <Button
          variant="ghost"
          type="button"
          aria-label={`Browse workspace files for PR #${snapshot.review.pullRequestNumber}`}
          disabled={browseStatus === "loading"}
          onClick={() => void loadBrowse()}
        >
          <FolderOpen size={14} />
          {browseStatus === "loading" ? "Loading" : "Browse files"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Search review workspace files"
          className="no-drag min-w-0 flex-1 basis-40 rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value.slice(0, 80))}
        />
        <Button
          variant="ghost"
          type="button"
          aria-label="Run review workspace file search"
          disabled={!searchQuery.trim() || searchStatus === "loading"}
          onClick={() => void runSearch()}
        >
          <Search size={14} />
          {searchStatus === "loading" ? "Searching" : "Search"}
        </Button>
      </div>
      {browseStatus === "error" ? (
        <p className="text-xs" style={{ color: "var(--danger)" }}>{browseError ?? "File list unavailable"}</p>
      ) : null}
      {browse?.entries.items.length ? (
        <div className="grid gap-1">
          {browse.entries.items.map((entry) => renderEntry(entry, "browse"))}
        </div>
      ) : null}
      {searchStatus === "error" ? (
        <p className="text-xs" style={{ color: "var(--danger)" }}>{searchError ?? "File search unavailable"}</p>
      ) : null}
      {searchResult?.matches.items.length ? (
        <div className="grid gap-1">
          {searchResult.matches.items.map((entry) => renderEntry(entry, "search"))}
        </div>
      ) : null}
    </div>
  );
}

function FileContentPanel({
  status,
  file,
  error,
  writeStatus,
  writeError,
  projectId,
  worktreeId,
  onSave,
}: {
  status: FileReadStatus;
  file: FileReadResponse | null;
  error: string | null;
  writeStatus: FileWriteStatus;
  writeError: string | null;
  projectId: string;
  worktreeId: string;
  onSave: (request: { projectId: string; worktreeId: string; path: string; content: string; baseEtag: string | null }) => void;
}) {
  const [draft, setDraft] = useState(file?.content ?? "");

  useEffect(() => {
    setDraft(file?.content ?? "");
  }, [file?.metadata.etag, file?.content]);

  if (status === "loading") {
    return (
      <p className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
        Loading file...
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
        {error ?? "File content unavailable"}
      </p>
    );
  }
  if (!file) return null;

  const dirty = draft !== file.content;
  const saveDisabled = writeStatus === "saving" || !dirty || file.truncated;

  return (
    <div className="grid gap-2 rounded-md border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
        <span className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
          {`${file.metadata.sizeBytes} bytes`}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {writeStatus === "saved" ? (
            <span className="text-xs" style={{ color: "var(--success)" }}>
              Saved
            </span>
          ) : null}
          {file.truncated ? (
            <span className="text-xs" style={{ color: "var(--warning)" }}>
              Truncated
            </span>
          ) : null}
          <Button
            variant="ghost"
            type="button"
            disabled={saveDisabled}
            aria-label={`Save file ${file.metadata.path}`}
            title={file.truncated ? "Cannot save truncated file" : `Save file ${file.metadata.path}`}
            onClick={() => onSave({
              projectId,
              worktreeId,
              path: file.metadata.path,
              content: draft,
              baseEtag: file.metadata.etag,
            })}
          >
            <Save size={14} />
            {writeStatus === "saving" ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
      <textarea
        aria-label={`Edit file ${file.metadata.path}`}
        className="min-h-[240px] max-h-80 resize-y overflow-auto rounded-b-md border-0 px-3 py-2 font-mono text-xs outline-none"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        style={{ background: "transparent", color: "var(--text-primary)" }}
      />
      {writeStatus === "error" ? (
        <p className="px-3 pb-2 text-xs" style={{ color: "var(--danger)" }}>
          {writeError ?? "File could not be saved. Refresh and try again."}
        </p>
      ) : null}
    </div>
  );
}

function reviewHunkKey(fileIndex: number, file: ReviewSnapshotFile, hunk: ReviewSnapshotHunk, hunkIndex: number): string {
  return `${fileIndex}\u0000${file.path}\u0000${hunk.id}\u0000${hunkIndex}`;
}

function safeReferenceSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/\.\.+/g, "_").slice(0, 64) || "ref";
}

export function reviewHunkFollowUpDraft(summary: RuntimeSummary, snapshot: ReviewSnapshot, selected: SelectedReviewHunk): AgentThreadComposerDraft {
  const base = defaultAgentThreadComposerDraft(summary);
  const range = formatHunkRange(selected.hunk);
  const hunkNumber = selected.hunkIndex + 1;
  return {
    ...base,
    projectId: snapshot.review.projectId,
    prompt: [
      "Please follow up on this review hunk.",
      "",
      `Review: PR #${snapshot.review.pullRequestNumber}, round ${snapshot.review.round} of ${snapshot.review.maxRounds}`,
      `Project: ${snapshot.review.projectId}`,
      `File: ${selected.file.path}`,
      `Hunk: ${range}`,
      "",
      "Use the structured reference attached to inspect the current source and propose the smallest safe fix.",
    ].join("\n"),
    attachments: [
      {
        id: `review:${safeReferenceSegment(snapshot.review.id)}:hunk:${safeReferenceSegment(selected.hunk.id)}`,
        kind: "structured_ref",
        label: `Review hunk ${hunkNumber}`,
        path: selected.file.path,
      },
    ],
  };
}

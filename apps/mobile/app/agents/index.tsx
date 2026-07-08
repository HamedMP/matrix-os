import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { CodingAgentNotificationPreferences, CodingAgentNotificationPreferencesUpdate, FileBrowseResponse, FileReadRequest, FileReadResponse, FileSearchResponse, FileWriteRequest, PreviewSessionSummary, ReviewSnapshot, ReviewSummary, RuntimeSummary, SourceControlCreatePullRequestRequest, SourceControlCreatePullRequestResponse, SourceControlPrepareCommitRequest } from "@matrix-os/contracts";
import { useGateway } from "@/app/_layout";
import { CODING_AGENTS_MOBILE_WORKSPACE } from "@/lib/feature-flags";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";
import { isSafeShellSessionName } from "@/lib/terminal-state";

type ScreenState =
  | { status: "loading"; summary: null; error: null }
  | { status: "ready"; summary: RuntimeSummary; error: null }
  | { status: "error"; summary: null; error: "Runtime summary unavailable" };

const INITIAL_STATE: ScreenState = { status: "loading", summary: null, error: null };

type ReviewState =
  | { status: "idle"; reviews: null; error: null }
  | { status: "loading"; reviews: null; error: null }
  | { status: "ready"; reviews: { items: ReviewSummary[]; hasMore: boolean; nextCursor?: string; limit: number }; error: null }
  | { status: "error"; reviews: null; error: "Review state unavailable" };

const INITIAL_REVIEW_STATE: ReviewState = { status: "idle", reviews: null, error: null };

type NotificationPreferencesState =
  | { status: "idle"; preferences: null; error: null }
  | { status: "loading"; preferences: null; error: null }
  | { status: "ready"; preferences: CodingAgentNotificationPreferences; error: null }
  | { status: "saving"; preferences: CodingAgentNotificationPreferences; error: null }
  | { status: "error"; preferences: CodingAgentNotificationPreferences | null; error: "Notification settings unavailable" | "Notification settings could not be saved. Try again." };

type ReviewSnapshotState =
  | { status: "idle"; selectedReviewId: null; snapshot: null; error: null }
  | { status: "loading"; selectedReviewId: string; snapshot: null; error: null }
  | { status: "ready"; selectedReviewId: string; snapshot: ReviewSnapshot; error: null }
  | { status: "error"; selectedReviewId: string; snapshot: null; error: "Review details unavailable" };

type FileContentState =
  | { status: "idle"; selectedPath: null; file: null; error: null }
  | { status: "loading"; selectedPath: string; file: null; error: null }
  | { status: "ready"; selectedPath: string; file: FileReadResponse; error: null }
  | { status: "error"; selectedPath: string; file: null; error: "File content unavailable" };

type FileSaveState =
  | { status: "idle"; error: null }
  | { status: "saving"; error: null }
  | { status: "saved"; error: null }
  | { status: "error"; error: "File could not be saved. Refresh and try again." };

type SourceCommitState =
  | { status: "idle"; error: null }
  | { status: "preparing"; error: null }
  | { status: "prepared"; error: null }
  | { status: "error"; error: "Source commit could not be prepared. Refresh and try again." };

type SourcePullRequestState =
  | { status: "idle"; error: null }
  | { status: "creating"; error: null }
  | { status: "ready"; pullRequest: SourceControlCreatePullRequestResponse; error: null }
  | { status: "error"; error: "Pull request could not be created. Refresh and try again." };

type FileReference = Pick<FileReadRequest, "projectId" | "worktreeId" | "path">;
type FileBrowserStatus = "idle" | "loading" | "ready" | "error";
type SummaryProvider = RuntimeSummary["providers"][number];
type SummaryThread = RuntimeSummary["activeThreads"]["items"][number];
type SummaryTerminalSession = RuntimeSummary["terminalSessions"]["items"][number];
type TerminalOpenError = "Terminal session unavailable. Try again.";
type RecentWorkItem =
  | {
    kind: "thread";
    key: string;
    title: string;
    subtitle: string;
    meta: string;
    attentionLabel: string | null;
    updatedAt: string;
    thread: SummaryThread;
  }
  | {
    kind: "terminal";
    key: string;
    title: string;
    subtitle: string;
    meta: string;
    attentionLabel: null;
    updatedAt: string;
    session: SummaryTerminalSession;
  };

type ReviewSnapshotHunk = ReviewSnapshot["files"]["items"][number]["hunks"][number];
type ReviewSnapshotLine = NonNullable<ReviewSnapshotHunk["lines"]>[number];

function canOpenExternalUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

type SelectedReviewHunk = {
  reviewId: string;
  snapshotKey: string;
  key: string;
  filePath: string;
  hunkId: string;
  hunkIndex: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
};

const INITIAL_REVIEW_SNAPSHOT_STATE: ReviewSnapshotState = {
  status: "idle",
  selectedReviewId: null,
  snapshot: null,
  error: null,
};

const INITIAL_NOTIFICATION_PREFERENCES_STATE: NotificationPreferencesState = {
  status: "idle",
  preferences: null,
  error: null,
};

type NotificationPreferenceKey = keyof CodingAgentNotificationPreferences["attentionPush"];
const NOTIFICATION_TOGGLES: { key: NotificationPreferenceKey; label: string; detail: string }[] = [
  { key: "approval", label: "Approval alerts", detail: "Approval-required runs" },
  { key: "input", label: "Input request alerts", detail: "Runs waiting for a response" },
  { key: "failed", label: "Failed run alerts", detail: "Runs that need recovery" },
];
const MAX_RECENT_WORK_ITEMS = 6;

const INITIAL_FILE_CONTENT_STATE: FileContentState = {
  status: "idle",
  selectedPath: null,
  file: null,
  error: null,
};

const INITIAL_FILE_SAVE_STATE: FileSaveState = { status: "idle", error: null };
const INITIAL_SOURCE_COMMIT_STATE: SourceCommitState = { status: "idle", error: null };
const INITIAL_SOURCE_PULL_REQUEST_STATE: SourcePullRequestState = { status: "idle", error: null };

const SECRET_LIKE_FINDING_TEXT =
  /(gh[psuor]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9_]{20,}|ya29[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:A3T|AKIA|ASIA)[A-Z0-9]{16}|bearer\s+[A-Za-z0-9._-]{12,}|sk(?:_live|_test)?[_-][A-Za-z0-9_-]{16,})/i;
const HIDDEN_FINDING_SUMMARY = "Finding summary hidden for safety.";
const HIDDEN_REVIEW_NOTICE = "Review notice hidden for safety.";
const HIDDEN_FILE_PATH = "File path hidden for safety.";

let fileSaveRequestSeq = 0;
let sourceCommitRequestSeq = 0;

function nextFileSaveRequestId(): string {
  fileSaveRequestSeq += 1;
  return `req_mobile_${Date.now().toString(36)}_${fileSaveRequestSeq}`;
}

function nextSourceCommitRequestId(): string {
  sourceCommitRequestSeq += 1;
  return `req_mobile_${Date.now().toString(36)}_${sourceCommitRequestSeq}`;
}

function capabilityEnabled(summary: RuntimeSummary, id: string): boolean {
  return summary.capabilities.some((capability) => capability.id === id && capability.enabled);
}

function timestampMs(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function recentThreadPriority(thread: SummaryThread): number {
  switch (thread.attention) {
    case "approval_required":
      return 0;
    case "input_required":
      return 1;
    case "failed":
      return 2;
    default:
      return 10;
  }
}

function recentWorkItems(summary: RuntimeSummary): RecentWorkItem[] {
  const threads: SummaryThread[] = [];

  for (const thread of summary.attentionThreads.items) {
    if (!threads.some((candidate) => candidate.id === thread.id)) {
      threads.push(thread);
    }
  }
  for (const thread of summary.activeThreads.items) {
    if (!threads.some((candidate) => candidate.id === thread.id)) {
      threads.push(thread);
    }
  }

  const threadItems = threads.map((thread) => {
    const attentionLabel = attentionThreadLabel(thread.attention) ?? threadAttentionLabel(thread.attention);
    return {
      kind: "thread" as const,
      key: `thread:${thread.id}`,
      title: thread.title,
      subtitle: attentionLabel ? `${thread.providerId} - ${attentionLabel}` : thread.providerId,
      meta: thread.status.replace(/_/g, " "),
      attentionLabel,
      updatedAt: thread.updatedAt,
      thread,
    };
  });
  threadItems.sort((left, right) => {
    const priority = recentThreadPriority(left.thread) - recentThreadPriority(right.thread);
    if (priority !== 0) return priority;
    return timestampMs(right.updatedAt) - timestampMs(left.updatedAt);
  });

  const terminalItems = summary.terminalSessions.items
    .filter((session) => session.status === "running" && session.attachable)
    .map((session) => ({
      kind: "terminal" as const,
      key: `terminal:${session.id}`,
      title: session.name,
      subtitle: "Terminal session",
      meta: session.status,
      attentionLabel: null,
      updatedAt: session.updatedAt,
      session,
    }));
  terminalItems.sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt));

  const threadLimit = terminalItems.length > 0 ? MAX_RECENT_WORK_ITEMS - 1 : MAX_RECENT_WORK_ITEMS;
  return [
    ...threadItems.slice(0, threadLimit),
    ...terminalItems,
  ].slice(0, MAX_RECENT_WORK_ITEMS);
}

function providerStatusLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function providerNeedsSetup(provider: SummaryProvider): boolean {
  const ready = provider.availability === "available"
    && provider.installStatus === "installed"
    && provider.authStatus === "authenticated";
  if (ready) return false;
  return provider.setupActions.length > 0
    || provider.availability === "setup_required"
    || provider.availability === "auth_required"
    || provider.installStatus === "missing"
    || provider.installStatus === "failed"
    || provider.authStatus === "missing"
    || provider.authStatus === "expired";
}

function setupRequiredProviders(summary: RuntimeSummary): SummaryProvider[] {
  return summary.providers.filter(providerNeedsSetup);
}

function safeFindingSummary(summary: string): string {
  return SECRET_LIKE_FINDING_TEXT.test(summary) ? HIDDEN_FINDING_SUMMARY : summary;
}

function safeSnapshotText(value: string, fallback: string): string {
  return SECRET_LIKE_FINDING_TEXT.test(value) ? fallback : value;
}

function fileReferenceMatches(left: FileReference | null, right: FileReference): boolean {
  return left?.projectId === right.projectId && left.worktreeId === right.worktreeId && left.path === right.path;
}

function formatHunkRange(hunk: ReviewSnapshotHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

function reviewDiffLineMarker(line: ReviewSnapshotLine): string {
  if (line.kind === "add") return "+";
  if (line.kind === "remove") return "-";
  return " ";
}

function reviewDiffOldLine(line: ReviewSnapshotLine): number | null {
  return "oldLine" in line ? line.oldLine : null;
}

function reviewDiffNewLine(line: ReviewSnapshotLine): number | null {
  return "newLine" in line ? line.newLine : null;
}

function reviewDiffLineLabel(line: ReviewSnapshotLine): string {
  const parts = [
    line.kind === "add" ? "Added line" : line.kind === "remove" ? "Removed line" : "Context line",
  ];
  const oldLine = reviewDiffOldLine(line);
  const newLine = reviewDiffNewLine(line);
  if (oldLine !== null) parts.push("old", String(oldLine));
  if (newLine !== null) parts.push("new", String(newLine));
  return parts.join(" ");
}

function reviewSnapshotSelectionKey(snapshot: ReviewSnapshot): string {
  return [
    snapshot.updatedAt,
    snapshot.files.items.length,
    snapshot.files.items.map((file) => [
      file.path,
      file.status,
      file.additions,
      file.deletions,
      file.partial ? "partial" : "complete",
      file.hunks.map((hunk) => `${hunk.id}:${hunk.oldStart}:${hunk.oldLines}:${hunk.newStart}:${hunk.newLines}:${hunk.partial ? "partial" : "complete"}`).join("|"),
    ].join(":")).join("\u0001"),
  ].join("\u0002");
}

function ReviewDiffLines({ lines }: { lines: ReviewSnapshotLine[] }) {
  if (!lines.length) return null;

  return (
    <View style={styles.reviewDiffLines}>
      {lines.map((line, index) => (
        <View
          key={`${line.kind}:${reviewDiffOldLine(line) ?? ""}:${reviewDiffNewLine(line) ?? ""}:${index}`}
          style={styles.reviewDiffLine}
        >
          <Text
            style={[
              styles.reviewDiffMarker,
              line.kind === "add" ? styles.reviewDiffAdded : null,
              line.kind === "remove" ? styles.reviewDiffRemoved : null,
            ]}
          >
            {reviewDiffLineMarker(line)}
          </Text>
          <Text style={styles.reviewDiffLineNumber}>{reviewDiffOldLine(line) ?? ""}</Text>
          <Text style={styles.reviewDiffLineNumber}>{reviewDiffNewLine(line) ?? ""}</Text>
          <Text
            accessibilityLabel={reviewDiffLineLabel(line)}
            selectable
            style={styles.reviewDiffContent}
          >
            {line.content}
          </Text>
        </View>
      ))}
    </View>
  );
}

export default function AgentsScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { client } = useGateway();
  const [state, setState] = useState<ScreenState>(INITIAL_STATE);
  const [notificationPreferencesState, setNotificationPreferencesState] = useState<NotificationPreferencesState>(INITIAL_NOTIFICATION_PREFERENCES_STATE);
  const [reviewState, setReviewState] = useState<ReviewState>(INITIAL_REVIEW_STATE);
  const [reviewSnapshotState, setReviewSnapshotState] = useState<ReviewSnapshotState>(INITIAL_REVIEW_SNAPSHOT_STATE);
  const [fileContentState, setFileContentState] = useState<FileContentState>(INITIAL_FILE_CONTENT_STATE);
  const [fileSaveState, setFileSaveState] = useState<FileSaveState>(INITIAL_FILE_SAVE_STATE);
  const [sourceCommitState, setSourceCommitState] = useState<SourceCommitState>(INITIAL_SOURCE_COMMIT_STATE);
  const [sourcePullRequestState, setSourcePullRequestState] = useState<SourcePullRequestState>(INITIAL_SOURCE_PULL_REQUEST_STATE);
  const [refreshing, setRefreshing] = useState(false);
  const [terminalOpenError, setTerminalOpenError] = useState<TerminalOpenError | null>(null);
  const requestGeneration = useRef(0);
  const notificationPreferencesGeneration = useRef(0);
  const notificationPreferencesRef = useRef<CodingAgentNotificationPreferences | null>(null);
  const notificationPreferenceSaveActiveRef = useRef(false);
  const pendingNotificationPreferencePatchRef = useRef<Partial<CodingAgentNotificationPreferences["attentionPush"]>>({});
  const reviewSnapshotGeneration = useRef(0);
  const fileContentGeneration = useRef(0);
  const selectedReviewIdRef = useRef<string | null>(null);
  const selectedFileReferenceRef = useRef<FileReference | null>(null);
  const activeFileSaveReferenceRef = useRef<FileReference | null>(null);

  const clearFileContent = useCallback(() => {
    fileContentGeneration.current += 1;
    selectedFileReferenceRef.current = null;
    activeFileSaveReferenceRef.current = null;
    setFileContentState(INITIAL_FILE_CONTENT_STATE);
    setFileSaveState(INITIAL_FILE_SAVE_STATE);
    setSourceCommitState(INITIAL_SOURCE_COMMIT_STATE);
    setSourcePullRequestState(INITIAL_SOURCE_PULL_REQUEST_STATE);
  }, []);

  const clearReviewSnapshot = useCallback(() => {
    reviewSnapshotGeneration.current += 1;
    selectedReviewIdRef.current = null;
    clearFileContent();
    setReviewSnapshotState(INITIAL_REVIEW_SNAPSHOT_STATE);
  }, [clearFileContent]);

  const loadReviewSnapshot = useCallback(async (reviewId: string) => {
    clearFileContent();
    if (!client) {
      selectedReviewIdRef.current = reviewId;
      setReviewSnapshotState({
        status: "error",
        selectedReviewId: reviewId,
        snapshot: null,
        error: "Review details unavailable",
      });
      return;
    }
    const generation = reviewSnapshotGeneration.current + 1;
    reviewSnapshotGeneration.current = generation;
    selectedReviewIdRef.current = reviewId;
    setReviewSnapshotState({
      status: "loading",
      selectedReviewId: reviewId,
      snapshot: null,
      error: null,
    });
    const result = await client.getCodingAgentReviewSnapshot({ reviewId });
    if (generation !== reviewSnapshotGeneration.current) return;
    if (result.ok) {
      selectedReviewIdRef.current = reviewId;
      setReviewSnapshotState({
        status: "ready",
        selectedReviewId: reviewId,
        snapshot: result.snapshot,
        error: null,
      });
      return;
    }
    selectedReviewIdRef.current = reviewId;
    setReviewSnapshotState({
      status: "error",
      selectedReviewId: reviewId,
      snapshot: null,
      error: "Review details unavailable",
    });
  }, [clearFileContent, client]);

  const loadFileContent = useCallback(async (request: FileReadRequest) => {
    selectedFileReferenceRef.current = request;
    activeFileSaveReferenceRef.current = null;
    if (!client) {
      setFileContentState({
        status: "error",
        selectedPath: request.path,
        file: null,
        error: "File content unavailable",
      });
      return;
    }
    const generation = fileContentGeneration.current + 1;
    fileContentGeneration.current = generation;
    setFileContentState({
      status: "loading",
      selectedPath: request.path,
      file: null,
      error: null,
    });
    setFileSaveState(INITIAL_FILE_SAVE_STATE);
    const result = await client.getCodingAgentFileContent(request);
    if (generation !== fileContentGeneration.current) return;
    if (result.ok) {
      selectedFileReferenceRef.current = request;
      setFileContentState({
        status: "ready",
        selectedPath: request.path,
        file: result.file,
        error: null,
      });
      setFileSaveState(INITIAL_FILE_SAVE_STATE);
      return;
    }
    selectedFileReferenceRef.current = request;
    setFileContentState({
      status: "error",
      selectedPath: request.path,
      file: null,
      error: "File content unavailable",
    });
    setFileSaveState(INITIAL_FILE_SAVE_STATE);
  }, [client]);

  const saveFileContent = useCallback(async (
    request: Omit<FileWriteRequest, "encoding" | "clientRequestId">,
  ) => {
    if (!client || fileSaveState.status === "saving") return;
    activeFileSaveReferenceRef.current = request;
    setFileSaveState({ status: "saving", error: null });
    const result = await client.saveCodingAgentFileContent({
      ...request,
      encoding: "utf8",
      clientRequestId: nextFileSaveRequestId(),
    });
    if (!fileReferenceMatches(activeFileSaveReferenceRef.current, request)) return;
    activeFileSaveReferenceRef.current = null;
    if (!fileReferenceMatches(selectedFileReferenceRef.current, request)) {
      setFileSaveState(INITIAL_FILE_SAVE_STATE);
      return;
    }
    if (!result.ok) {
      setFileSaveState({
        status: "error",
        error: "File could not be saved. Refresh and try again.",
      });
      return;
    }
    setFileContentState((current) => {
      if (current.status !== "ready" || !fileReferenceMatches(selectedFileReferenceRef.current, request)) {
        return current;
      }
      return {
        status: "ready",
        selectedPath: request.path,
        file: {
          metadata: result.file.metadata,
          content: request.content,
          encoding: "utf8",
          truncated: false,
          limitBytes: current.file.limitBytes,
        },
        error: null,
      };
    });
    setFileSaveState({ status: "saved", error: null });
  }, [client, fileSaveState.status]);

  const prepareSourceCommit = useCallback(async (
    request: Omit<SourceControlPrepareCommitRequest, "clientRequestId">,
  ) => {
    const initiatingReview = reviewSnapshotState.status === "ready" ? reviewSnapshotState.snapshot.review : null;
    const initiatingReviewId = initiatingReview?.id ?? null;
    if (!client || sourceCommitState.status === "preparing" || !initiatingReview || !initiatingReviewId) return;
    setSourceCommitState({ status: "preparing", error: null });
    const result = await client.prepareCodingAgentSourceCommit({
      ...request,
      clientRequestId: nextSourceCommitRequestId(),
    });
    if (!result.ok) {
      if (selectedReviewIdRef.current !== initiatingReviewId) return;
      setSourceCommitState({
        status: "error",
        error: "Source commit could not be prepared. Refresh and try again.",
      });
      return;
    }
    if (
      selectedReviewIdRef.current !== initiatingReviewId
      || initiatingReview.projectId !== request.projectId
      || initiatingReview.worktreeId !== request.worktreeId
    ) {
      setSourceCommitState(INITIAL_SOURCE_COMMIT_STATE);
      return;
    }
    setSourceCommitState({ status: "prepared", error: null });
  }, [client, reviewSnapshotState, sourceCommitState.status]);

  const createSourcePullRequest = useCallback(async (
    request: Omit<SourceControlCreatePullRequestRequest, "clientRequestId">,
  ) => {
    const initiatingReview = reviewSnapshotState.status === "ready" ? reviewSnapshotState.snapshot.review : null;
    const initiatingReviewId = initiatingReview?.id ?? null;
    if (!client || sourcePullRequestState.status === "creating" || !initiatingReview || !initiatingReviewId) return;
    setSourcePullRequestState({ status: "creating", error: null });
    const result = await client.createCodingAgentSourcePullRequest({
      ...request,
      clientRequestId: nextSourceCommitRequestId(),
    });
    if (!result.ok) {
      if (selectedReviewIdRef.current !== initiatingReviewId) return;
      setSourcePullRequestState({
        status: "error",
        error: "Pull request could not be created. Refresh and try again.",
      });
      return;
    }
    if (
      selectedReviewIdRef.current !== initiatingReviewId
      || initiatingReview.projectId !== request.projectId
      || initiatingReview.worktreeId !== request.worktreeId
    ) {
      setSourcePullRequestState(INITIAL_SOURCE_PULL_REQUEST_STATE);
      return;
    }
    setSourcePullRequestState({ status: "ready", pullRequest: result.pullRequest, error: null });
  }, [client, reviewSnapshotState, sourcePullRequestState.status]);

  const loadSummary = useCallback(async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    if (!CODING_AGENTS_MOBILE_WORKSPACE) {
      setState({ status: "error", summary: null, error: "Runtime summary unavailable" });
      setReviewState(INITIAL_REVIEW_STATE);
      clearReviewSnapshot();
      return;
    }
    if (!client) {
      setState({ status: "error", summary: null, error: "Runtime summary unavailable" });
      setReviewState(INITIAL_REVIEW_STATE);
      clearReviewSnapshot();
      return;
    }
    const result = await client.getCodingAgentRuntimeSummary();
    if (generation !== requestGeneration.current) return;
    if (result.ok) {
      setState({ status: "ready", summary: result.summary, error: null });
      if (!capabilityEnabled(result.summary, "codingAgentsReview")) {
        setReviewState(INITIAL_REVIEW_STATE);
        clearReviewSnapshot();
        return;
      }
      setReviewState((current) => (current.reviews ? current : { status: "loading", reviews: null, error: null }));
      const reviewsResult = await client.getCodingAgentReviews();
      if (generation !== requestGeneration.current) return;
      if (reviewsResult.ok) {
        setReviewState({ status: "ready", reviews: reviewsResult.reviews, error: null });
        const selectedReviewId = selectedReviewIdRef.current;
        if (!selectedReviewId) return;
        if (reviewsResult.reviews.items.some((review) => review.id === selectedReviewId)) {
          void loadReviewSnapshot(selectedReviewId);
          return;
        }
        clearReviewSnapshot();
        return;
      }
      setReviewState({ status: "error", reviews: null, error: "Review state unavailable" });
      clearReviewSnapshot();
      return;
    }
    setState({ status: "error", summary: null, error: "Runtime summary unavailable" });
    setReviewState(INITIAL_REVIEW_STATE);
    clearReviewSnapshot();
  }, [clearReviewSnapshot, client, loadReviewSnapshot]);

  const loadNotificationPreferences = useCallback(async () => {
    const generation = notificationPreferencesGeneration.current + 1;
    notificationPreferencesGeneration.current = generation;
    if (!client || typeof client.getCodingAgentNotificationPreferences !== "function") {
      setNotificationPreferencesState({
        status: "error",
        preferences: null,
        error: "Notification settings unavailable",
      });
      return;
    }
    setNotificationPreferencesState((current) => (
      current.preferences ? current : { status: "loading", preferences: null, error: null }
    ));
    const result = await client.getCodingAgentNotificationPreferences();
    if (generation !== notificationPreferencesGeneration.current) return;
    if (result.ok) {
      notificationPreferencesRef.current = result.preferences;
      setNotificationPreferencesState({ status: "ready", preferences: result.preferences, error: null });
      return;
    }
    setNotificationPreferencesState({
      status: "error",
      preferences: null,
      error: "Notification settings unavailable",
    });
  }, [client]);

  const flushNotificationPreferenceUpdates = useCallback(async () => {
    if (
      !client
      || typeof client.getCodingAgentNotificationPreferences !== "function"
      || typeof client.updateCodingAgentNotificationPreferences !== "function"
      || notificationPreferenceSaveActiveRef.current
    ) {
      return;
    }
    notificationPreferenceSaveActiveRef.current = true;
    try {
      while (Object.keys(pendingNotificationPreferencePatchRef.current).length > 0) {
        const patch = pendingNotificationPreferencePatchRef.current;
        pendingNotificationPreferencePatchRef.current = {};
        const previous = notificationPreferencesRef.current;
        if (!previous) {
          pendingNotificationPreferencePatchRef.current = {};
          setNotificationPreferencesState({
            status: "error",
            preferences: null,
            error: "Notification settings could not be saved. Try again.",
          });
          return;
        }
        setNotificationPreferencesState({
          status: "saving",
          preferences: previous,
          error: null,
        });
        const latest = await client.getCodingAgentNotificationPreferences();
        if (!latest.ok) {
          setNotificationPreferencesState({
            status: "error",
            preferences: previous,
            error: "Notification settings could not be saved. Try again.",
          });
          return;
        }
        const request: CodingAgentNotificationPreferencesUpdate = {
          attentionPush: {
            ...latest.preferences.attentionPush,
            ...patch,
          },
        };
        const result = await client.updateCodingAgentNotificationPreferences(request);
        if (!result.ok) {
          setNotificationPreferencesState({
            status: "error",
            preferences: previous,
            error: "Notification settings could not be saved. Try again.",
          });
          return;
        }
        notificationPreferencesRef.current = result.preferences;
        setNotificationPreferencesState({ status: "ready", preferences: result.preferences, error: null });
      }
    } finally {
      notificationPreferenceSaveActiveRef.current = false;
    }
    if (Object.keys(pendingNotificationPreferencePatchRef.current).length > 0) {
      void flushNotificationPreferenceUpdates();
    }
  }, [client]);

  const updateNotificationPreferences = useCallback((
    request: { attentionPush: Partial<CodingAgentNotificationPreferences["attentionPush"]> },
  ) => {
    const previous = notificationPreferencesRef.current;
    if (!previous) return;
    pendingNotificationPreferencePatchRef.current = {
      ...pendingNotificationPreferencePatchRef.current,
      ...request.attentionPush,
    };
    const optimistic = {
      ...previous,
      attentionPush: {
        ...previous.attentionPush,
        ...request.attentionPush,
      },
    };
    notificationPreferencesRef.current = optimistic;
    setNotificationPreferencesState({
      status: "saving",
      preferences: optimistic,
      error: null,
    });
    void flushNotificationPreferenceUpdates();
  }, [flushNotificationPreferenceUpdates]);

  useEffect(() => {
    setState((current) => (current.summary ? current : INITIAL_STATE));
    void loadSummary();
    void loadNotificationPreferences();
  }, [loadNotificationPreferences, loadSummary]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadSummary();
      await loadNotificationPreferences();
    } finally {
      setRefreshing(false);
    }
  }, [loadNotificationPreferences, loadSummary]);

  const openTerminalSession = useCallback(async (session: SummaryTerminalSession) => {
    setTerminalOpenError(null);
    if (!isSafeShellSessionName(session.name)) {
      setTerminalOpenError("Terminal session unavailable. Try again.");
      return;
    }
    try {
      const savedState = await loadMobileShellState();
      await saveMobileShellState({
        ...savedState,
        mode: "terminal",
        lastActiveTerminalSessionId: session.name,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      console.warn("[mobile] failed to remember recent terminal session");
      setTerminalOpenError("Terminal session unavailable. Try again.");
      return;
    }
    router.push("/terminal");
  }, [router]);

  const selectReview = useCallback((reviewId: string) => {
    void loadReviewSnapshot(reviewId);
  }, [loadReviewSnapshot]);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.forest} />
        <Text style={styles.centerTitle}>Loading workspace...</Text>
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.centered}>
        <Ionicons name="warning-outline" size={28} color={theme.colors.moss} />
        <Text style={styles.centerTitle}>{state.error}</Text>
        <Text style={styles.centerBody}>Refresh the workspace or check your selected runtime.</Text>
        <Pressable accessibilityRole="button" onPress={onRefresh} style={styles.retryButton}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const summary = state.summary;
  const canCreate = capabilityEnabled(summary, "codingAgentsThreadCreate");
  const canPrepareCommit = capabilityEnabled(summary, "codingAgentsSourceControl");
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      accessibilityLabel="Refresh agent workspace"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.forest} />}
    >
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="sparkles-outline" size={22} color={theme.colors.forest} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>Agent workspace</Text>
          <Text style={styles.subtitle}>{summary.runtime.label}</Text>
        </View>
        {canCreate ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New run"
            onPress={() => router.push("/agents/new" as any)}
            style={styles.newRunButton}
          >
            <Ionicons name="add" size={18} color={theme.colors.background} />
            <Text style={styles.newRunText}>New</Text>
          </Pressable>
        ) : null}
      </View>

      <Section title="Notifications" count={NOTIFICATION_TOGGLES.length}>
        <View style={styles.notificationPanel}>
          {NOTIFICATION_TOGGLES.map((item) => {
            const preferences = notificationPreferencesState.preferences;
            const disabled = notificationPreferencesState.status === "loading"
              || notificationPreferencesState.status === "saving"
              || !preferences;
            return (
              <View key={item.key} style={styles.notificationRow}>
                <View style={styles.notificationText}>
                  <Text style={styles.rowTitle}>{item.label}</Text>
                  <Text style={styles.rowSubtitle}>{item.detail}</Text>
                </View>
                <Switch
                  accessibilityLabel={item.label}
                  accessibilityRole="switch"
                  value={Boolean(preferences?.attentionPush[item.key])}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (!preferences) return;
                    void updateNotificationPreferences({
                      attentionPush: { [item.key]: value },
                    });
                  }}
                  trackColor={{ false: theme.colors.border, true: theme.colors.moss }}
                  thumbColor={theme.colors.background}
                />
              </View>
            );
          })}
          {notificationPreferencesState.error ? (
            <Text style={styles.notificationError}>{notificationPreferencesState.error}</Text>
          ) : null}
        </View>
      </Section>

      <RecentWorkSection
        summary={summary}
        canCreate={canCreate}
        terminalOpenError={terminalOpenError}
        onCreate={() => router.push("/agents/new")}
        onOpenThread={(thread) => router.push(`/agents/${thread.id}` as any)}
        onOpenTerminal={(session) => void openTerminalSession(session)}
      />

      <ProviderSetupSection summary={summary} />

      <Section title="Providers" count={summary.providers.length}>
        {summary.providers.length === 0 ? <EmptyText>No providers are ready.</EmptyText> : null}
        {summary.providers.map((provider) => (
          <View key={provider.id} style={styles.row}>
            <View style={styles.rowIcon}>
              <Ionicons name="cube-outline" size={18} color={theme.colors.moss} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{provider.displayName}</Text>
              <Text style={styles.rowSubtitle}>{providerStatusLabel(provider.availability)}</Text>
            </View>
            <Text style={styles.rowMeta}>{providerStatusLabel(provider.authStatus)}</Text>
          </View>
        ))}
      </Section>

      <Section title="Needs Attention" count={summary.attentionThreads.items.length}>
        {summary.attentionThreads.items.length === 0 ? <EmptyText>No attention needed.</EmptyText> : null}
        {summary.attentionThreads.items.map((thread) => {
          const attentionLabel = attentionThreadLabel(thread.attention) ?? thread.status.replace(/_/g, " ");

          return (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              accessibilityLabel={`Open attention thread ${thread.title}, ${attentionLabel}`}
              onPress={() => router.push(`/agents/${thread.id}` as any)}
              style={styles.row}
            >
              <View style={styles.rowIcon}>
                <Ionicons name="git-branch-outline" size={18} color={theme.colors.moss} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{thread.title}</Text>
                <Text style={styles.rowSubtitle}>{thread.providerId}</Text>
                <Text style={styles.attentionBadge}>{attentionLabel}</Text>
              </View>
              <Text style={styles.rowMeta}>{thread.status.replace(/_/g, " ")}</Text>
            </Pressable>
          );
        })}
      </Section>

      <Section title="Active Threads" count={summary.activeThreads.items.length}>
        {summary.activeThreads.items.length === 0 ? <EmptyText>No active threads.</EmptyText> : null}
        {summary.activeThreads.items.map((thread) => {
          const attentionLabel = threadAttentionLabel(thread.attention);

          return (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              accessibilityLabel={attentionLabel
                ? `Open thread ${thread.title}, ${attentionLabel}`
                : `Open thread ${thread.title}`}
              onPress={() => router.push(`/agents/${thread.id}` as any)}
              style={styles.row}
            >
              <View style={styles.rowIcon}>
                <Ionicons name="git-branch-outline" size={18} color={theme.colors.moss} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{thread.title}</Text>
                <Text style={styles.rowSubtitle}>{thread.providerId}</Text>
                {attentionLabel ? <Text style={styles.attentionBadge}>{attentionLabel}</Text> : null}
              </View>
              <Text style={styles.rowMeta}>{thread.status.replace(/_/g, " ")}</Text>
            </Pressable>
          );
        })}
      </Section>

      {capabilityEnabled(summary, "codingAgentsPreview") ? (
        <PreviewSection
          summary={summary}
          onOpenPreview={(preview) => {
            router.push({
              pathname: "/agents/preview",
              params: {
                id: preview.id,
              },
            });
          }}
        />
      ) : null}

      <Section title="Terminals" count={summary.terminalSessions.items.length}>
        {summary.terminalSessions.items.length === 0 ? <EmptyText>No terminal sessions.</EmptyText> : null}
        {summary.terminalSessions.items.map((session) => (
          <View key={session.id} style={styles.row}>
            <View style={styles.rowIcon}>
              <Ionicons name="terminal-outline" size={18} color={theme.colors.moss} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{session.name}</Text>
              <Text style={styles.rowSubtitle}>{session.attachable ? "Attachable" : "Unavailable"}</Text>
            </View>
            <Text style={styles.rowMeta}>{session.status}</Text>
          </View>
        ))}
      </Section>

      {capabilityEnabled(summary, "codingAgentsReview") ? (
        <ReviewSection
          canCreate={canCreate}
          canReadFiles={capabilityEnabled(summary, "codingAgentsFiles")}
          state={reviewState}
          snapshotState={reviewSnapshotState}
          fileContentState={fileContentState}
          fileSaveState={fileSaveState}
          sourceCommitState={sourceCommitState}
          sourcePullRequestState={sourcePullRequestState}
          onSelectReview={selectReview}
          onOpenFile={loadFileContent}
          onSaveFile={saveFileContent}
          canPrepareCommit={canPrepareCommit}
          onPrepareCommit={prepareSourceCommit}
          onCreatePullRequest={createSourcePullRequest}
        />
      ) : null}
    </ScrollView>
  );
}

function RecentWorkSection({
  summary,
  canCreate,
  terminalOpenError,
  onCreate,
  onOpenThread,
  onOpenTerminal,
}: {
  summary: RuntimeSummary;
  canCreate: boolean;
  terminalOpenError: TerminalOpenError | null;
  onCreate: () => void;
  onOpenThread: (thread: SummaryThread) => void;
  onOpenTerminal: (session: SummaryTerminalSession) => void;
}) {
  const { theme } = useUnistyles();
  const items = recentWorkItems(summary);
  const count = items.length + (canCreate ? 1 : 0);

  return (
    <Section title="Recent Work" count={count}>
      {canCreate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a new coding-agent run"
          onPress={onCreate}
          style={({ pressed }) => [
            styles.row,
            pressed ? styles.rowPressed : null,
          ]}
        >
          <View style={styles.rowIcon}>
            <Ionicons name="add" size={18} color={theme.colors.moss} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>New run</Text>
            <Text style={styles.rowSubtitle}>Start from a fresh prompt</Text>
          </View>
          <Text style={styles.rowMeta}>Create</Text>
        </Pressable>
      ) : null}
      {items.length === 0 ? <EmptyText>No recent work yet.</EmptyText> : null}
      {items.map((item) => {
        if (item.kind === "thread") {
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityLabel={item.attentionLabel
                ? `Open recent work ${item.title}, ${item.attentionLabel}`
                : `Open recent work ${item.title}`}
              onPress={() => onOpenThread(item.thread)}
              style={({ pressed }) => [
                styles.row,
                pressed ? styles.rowPressed : null,
              ]}
            >
              <View style={styles.rowIcon}>
                <Ionicons name="git-branch-outline" size={18} color={theme.colors.moss} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{item.title}</Text>
                <Text style={styles.rowSubtitle}>{item.subtitle}</Text>
                {item.attentionLabel ? <Text style={styles.attentionBadge}>{item.attentionLabel}</Text> : null}
              </View>
              <Text style={styles.rowMeta}>{item.meta}</Text>
            </Pressable>
          );
        }

        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={`Open recent terminal ${item.title}`}
            onPress={() => onOpenTerminal(item.session)}
            style={({ pressed }) => [
              styles.row,
              pressed ? styles.rowPressed : null,
            ]}
          >
            <View style={styles.rowIcon}>
              <Ionicons name="terminal-outline" size={18} color={theme.colors.moss} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{item.title}</Text>
              <Text style={styles.rowSubtitle}>{item.subtitle}</Text>
            </View>
            <Text style={styles.rowMeta}>{item.meta}</Text>
          </Pressable>
        );
      })}
      {terminalOpenError ? <Text style={styles.notificationError}>{terminalOpenError}</Text> : null}
    </Section>
  );
}

function ProviderSetupSection({ summary }: { summary: RuntimeSummary }) {
  const { theme } = useUnistyles();
  const providers = setupRequiredProviders(summary);
  if (providers.length === 0) return null;

  return (
    <Section title="Provider Setup" count={providers.length}>
      {providers.map((provider) => (
        <View
          key={provider.id}
          accessible
          accessibilityLabel={`Provider setup needed for ${provider.displayName}, ${providerStatusLabel(provider.availability)}`}
          style={styles.row}
        >
          <View style={styles.rowIcon}>
            <Ionicons name="warning-outline" size={18} color={theme.colors.moss} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{provider.displayName}</Text>
            <Text style={styles.rowSubtitle}>
              {`${providerStatusLabel(provider.availability)} - ${providerStatusLabel(provider.installStatus)} / ${providerStatusLabel(provider.authStatus)}`}
            </Text>
            {provider.setupActions.length > 0 ? (
              <View style={styles.providerSetupActions}>
                {provider.setupActions.map((action, index) => (
                  <Text key={`${provider.id}:${index}:${action.id}:${action.kind}`} style={styles.attentionBadge}>
                    {action.label}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
          <Text style={styles.rowMeta}>Setup</Text>
        </View>
      ))}
    </Section>
  );
}

function PreviewSection({
  summary,
  onOpenPreview,
}: {
  summary: RuntimeSummary;
  onOpenPreview: (preview: PreviewSessionSummary) => void;
}) {
  const { theme } = useUnistyles();
  const previews = summary.previewSessions ?? { items: [], hasMore: false, limit: 50 };

  return (
    <Section title="Previews" count={previews.items.length}>
      {previews.items.length === 0 ? <EmptyText>No previews.</EmptyText> : null}
      {previews.items.map((preview) => (
        <Pressable
          key={preview.id}
          accessibilityRole="button"
          accessibilityLabel={`Open preview ${preview.label}`}
          onPress={() => onOpenPreview(preview)}
          style={({ pressed }) => [
            styles.row,
            pressed ? styles.rowPressed : null,
          ]}
        >
          <View style={styles.rowIcon}>
            <Ionicons name="browsers-outline" size={18} color={theme.colors.moss} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{preview.label}</Text>
            <Text style={styles.rowSubtitle}>{preview.origin ?? "No local origin"}</Text>
          </View>
          <Text style={styles.rowMeta}>{preview.status}</Text>
        </Pressable>
      ))}
    </Section>
  );
}

function reviewStatusLabel(status: ReviewSummary["status"]): string {
  return status.replace(/_/g, " ");
}

function threadAttentionLabel(attention?: string): string | null {
  switch (attention) {
    case "approval_required":
      return "Approval needed";
    case "input_required":
      return "Input needed";
    default:
      return null;
  }
}

function attentionThreadLabel(attention?: string): string | null {
  switch (attention) {
    case "approval_required":
    case "input_required":
      return threadAttentionLabel(attention);
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
    default:
      return null;
  }
}

function ReviewSection({
  canCreate,
  canReadFiles,
  state,
  snapshotState,
  fileContentState,
  fileSaveState,
  sourceCommitState,
  sourcePullRequestState,
  onSelectReview,
  onOpenFile,
  onSaveFile,
  canPrepareCommit,
  onPrepareCommit,
  onCreatePullRequest,
}: {
  canCreate: boolean;
  canReadFiles: boolean;
  state: ReviewState;
  snapshotState: ReviewSnapshotState;
  fileContentState: FileContentState;
  fileSaveState: FileSaveState;
  sourceCommitState: SourceCommitState;
  sourcePullRequestState: SourcePullRequestState;
  onSelectReview: (reviewId: string) => void;
  onOpenFile: (request: FileReadRequest) => void;
  onSaveFile: (request: Omit<FileWriteRequest, "encoding" | "clientRequestId">) => void;
  canPrepareCommit: boolean;
  onPrepareCommit: (request: Omit<SourceControlPrepareCommitRequest, "clientRequestId">) => void;
  onCreatePullRequest: (request: Omit<SourceControlCreatePullRequestRequest, "clientRequestId">) => void;
}) {
  const { theme } = useUnistyles();
  const items = state.reviews?.items ?? [];

  return (
    <Section title="Review" count={items.length}>
      {state.status === "error" ? <Text style={styles.reviewError}>{state.error}</Text> : null}
      {items.length === 0 && state.status !== "loading" && state.status !== "error" ? <EmptyText>No reviews.</EmptyText> : null}
      {items.map((review) => (
        <Pressable
          key={review.id}
          accessibilityRole="button"
          accessibilityLabel={`Open review PR #${review.pullRequestNumber}`}
          onPress={() => onSelectReview(review.id)}
          style={[
            styles.row,
            snapshotState.selectedReviewId === review.id ? styles.selectedReviewRow : null,
          ]}
        >
          <View style={styles.rowIcon}>
            <Ionicons name="checkmark-done-outline" size={18} color={theme.colors.moss} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{review.projectId}</Text>
            <Text style={styles.rowSubtitle}>{`PR #${review.pullRequestNumber} - Round ${review.round} of ${review.maxRounds}`}</Text>
          </View>
          <View style={styles.reviewMeta}>
            <Text style={styles.rowMeta}>{reviewStatusLabel(review.status)}</Text>
            {review.findings ? (
              <Text style={[styles.reviewHigh, review.findings.high > 0 ? styles.reviewHighActive : null]}>
                {review.findings.high} high
              </Text>
            ) : null}
          </View>
        </Pressable>
      ))}
      <ReviewSnapshotPanel
        canCreate={canCreate}
        canReadFiles={canReadFiles}
        state={snapshotState}
        fileContentState={fileContentState}
        fileSaveState={fileSaveState}
        sourceCommitState={sourceCommitState}
        sourcePullRequestState={sourcePullRequestState}
        onOpenFile={onOpenFile}
        onSaveFile={onSaveFile}
        canPrepareCommit={canPrepareCommit}
        onPrepareCommit={onPrepareCommit}
        onCreatePullRequest={onCreatePullRequest}
      />
    </Section>
  );
}

function ReviewSnapshotPanel({
  canCreate,
  canReadFiles,
  state,
  fileContentState,
  fileSaveState,
  sourceCommitState,
  sourcePullRequestState,
  onOpenFile,
  onSaveFile,
  canPrepareCommit,
  onPrepareCommit,
  onCreatePullRequest,
}: {
  canCreate: boolean;
  canReadFiles: boolean;
  state: ReviewSnapshotState;
  fileContentState: FileContentState;
  fileSaveState: FileSaveState;
  sourceCommitState: SourceCommitState;
  sourcePullRequestState: SourcePullRequestState;
  onOpenFile: (request: FileReadRequest) => void;
  onSaveFile: (request: Omit<FileWriteRequest, "encoding" | "clientRequestId">) => void;
  canPrepareCommit: boolean;
  onPrepareCommit: (request: Omit<SourceControlPrepareCommitRequest, "clientRequestId">) => void;
  onCreatePullRequest: (request: Omit<SourceControlCreatePullRequestRequest, "clientRequestId">) => void;
}) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [selectedHunk, setSelectedHunk] = useState<SelectedReviewHunk | null>(null);

  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return <Text style={styles.reviewDetailNotice}>Loading review details...</Text>;
  }
  if (state.status === "error") {
    return <Text style={styles.reviewError}>{state.error}</Text>;
  }

  const snapshotKey = reviewSnapshotSelectionKey(state.snapshot);
  const activeSelectedHunk = selectedHunk?.reviewId === state.selectedReviewId && selectedHunk.snapshotKey === snapshotKey
    ? selectedHunk
    : null;
  const prepareCommitPaths = state.snapshot.files.items.map((file) => file.path).slice(0, 100);
  const prepareCommitDisabled = sourceCommitState.status === "preparing" || prepareCommitPaths.length === 0;
  const createPullRequestDisabled = sourcePullRequestState.status === "creating";
  const sourcePullRequestUrl = sourcePullRequestState.status === "ready" && canOpenExternalUrl(sourcePullRequestState.pullRequest.url)
    ? sourcePullRequestState.pullRequest.url
    : null;

  return (
    <View style={styles.reviewDetailPanel}>
      <View style={styles.reviewDetailHeader}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{`PR #${state.snapshot.review.pullRequestNumber} review details`}</Text>
          <Text style={styles.rowSubtitle}>{`${state.snapshot.files.items.length} files${state.snapshot.partial ? " - partial" : ""}`}</Text>
        </View>
        <Text style={styles.rowMeta}>{reviewStatusLabel(state.snapshot.review.status)}</Text>
      </View>
      {canPrepareCommit ? (
        <View style={styles.reviewCommitActions}>
          {sourceCommitState.status === "prepared" ? (
            <Text style={styles.fileContentSaved}>Commit prepared</Text>
          ) : null}
          {sourceCommitState.status === "error" ? (
            <Text style={styles.reviewError}>{sourceCommitState.error}</Text>
          ) : null}
          {sourcePullRequestState.status === "ready" ? (
            <Text style={styles.fileContentSaved}>Pull request ready</Text>
          ) : null}
          {sourcePullRequestState.status === "error" ? (
            <Text style={styles.reviewError}>{sourcePullRequestState.error}</Text>
          ) : null}
          {sourcePullRequestState.status === "ready" && sourcePullRequestUrl ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open created pull request #${sourcePullRequestState.pullRequest.number}`}
              onPress={() => {
                void Linking.openURL(sourcePullRequestUrl).catch(() => {
                  console.warn("[agents] source pull request open failed");
                });
              }}
              style={styles.reviewFileOpenButton}
            >
              <Ionicons name="open-outline" size={15} color={theme.colors.background} />
              <Text style={styles.reviewFileOpenText}>Open PR</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Prepare commit for review PR #${state.snapshot.review.pullRequestNumber}`}
            accessibilityState={{ disabled: prepareCommitDisabled }}
            disabled={prepareCommitDisabled}
            onPress={() => onPrepareCommit({
              projectId: state.snapshot.review.projectId,
              worktreeId: state.snapshot.review.worktreeId,
              message: `fix: apply review updates for PR #${state.snapshot.review.pullRequestNumber}`,
              paths: prepareCommitPaths,
            })}
            style={[
              styles.reviewFileOpenButton,
              prepareCommitDisabled ? styles.fileContentSaveButtonDisabled : null,
            ]}
          >
            <Ionicons name="git-branch-outline" size={15} color={theme.colors.background} />
            <Text style={styles.reviewFileOpenText}>{sourceCommitState.status === "preparing" ? "Preparing" : "Prepare commit"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Create pull request for review PR #${state.snapshot.review.pullRequestNumber}`}
            accessibilityState={{ disabled: createPullRequestDisabled }}
            disabled={createPullRequestDisabled}
            onPress={() => onCreatePullRequest({
              projectId: state.snapshot.review.projectId,
              worktreeId: state.snapshot.review.worktreeId,
              title: `fix: apply review updates for PR #${state.snapshot.review.pullRequestNumber}`,
              body: "Review updates are ready.",
            })}
            style={[
              styles.reviewFileOpenButton,
              createPullRequestDisabled ? styles.fileContentSaveButtonDisabled : null,
            ]}
          >
            <Ionicons name="git-pull-request-outline" size={15} color={theme.colors.background} />
            <Text style={styles.reviewFileOpenText}>{sourcePullRequestState.status === "creating" ? "Creating" : "Create PR"}</Text>
          </Pressable>
        </View>
      ) : null}
      {state.snapshot.safeNotice ? (
        <Text style={styles.reviewDetailNotice}>{safeSnapshotText(state.snapshot.safeNotice, HIDDEN_REVIEW_NOTICE)}</Text>
      ) : null}
      {canReadFiles ? (
        <ReviewFileBrowserPanel
          key={`${state.snapshot.review.projectId}:${state.snapshot.review.worktreeId}:${state.snapshot.review.id}:${state.snapshot.updatedAt}`}
          snapshot={state.snapshot}
          canReadFiles={canReadFiles}
          onOpenFile={onOpenFile}
        />
      ) : null}
      {state.snapshot.files.items.map((file, fileIndex) => (
        <ReviewSnapshotFileRow
          key={`${file.path}:${fileIndex}`}
          file={file}
          fileIndex={fileIndex}
          selectedReviewId={state.selectedReviewId}
          snapshotKey={snapshotKey}
          selectedHunk={activeSelectedHunk}
          onSelectHunk={setSelectedHunk}
          canReadFiles={canReadFiles}
          reviewProjectId={state.snapshot.review.projectId}
          reviewWorktreeId={state.snapshot.review.worktreeId}
          fileContentState={fileContentState}
          fileSaveState={fileSaveState}
          onOpenFile={onOpenFile}
          onSaveFile={onSaveFile}
        />
      ))}
      {canCreate && activeSelectedHunk ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ask agent about selected hunk"
          onPress={() => router.push({
            pathname: "/agents/new",
            params: {
              reviewId: state.snapshot.review.id,
              projectId: state.snapshot.review.projectId,
              pullRequestNumber: String(state.snapshot.review.pullRequestNumber),
              round: String(state.snapshot.review.round),
              maxRounds: String(state.snapshot.review.maxRounds),
              filePath: activeSelectedHunk.filePath,
              hunkId: activeSelectedHunk.hunkId,
              hunkIndex: String(activeSelectedHunk.hunkIndex),
              oldStart: String(activeSelectedHunk.oldStart),
              oldLines: String(activeSelectedHunk.oldLines),
              newStart: String(activeSelectedHunk.newStart),
              newLines: String(activeSelectedHunk.newLines),
            },
          } as any)}
          style={styles.reviewFollowUpButton}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={16} color={theme.colors.background} />
          <Text style={styles.reviewFollowUpText}>Ask agent about selected hunk</Text>
        </Pressable>
      ) : null}
    </View>
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
  const { theme } = useUnistyles();
  const { client } = useGateway();
  const [browseStatus, setBrowseStatus] = useState<FileBrowserStatus>("idle");
  const [browse, setBrowse] = useState<FileBrowseResponse | null>(null);
  const [browseError, setBrowseError] = useState<"File list unavailable" | null>(null);
  const [searchStatus, setSearchStatus] = useState<FileBrowserStatus>("idle");
  const [searchResult, setSearchResult] = useState<FileSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<"File search unavailable" | null>(null);
  const [query, setQuery] = useState("");
  const projectId = snapshot.review.projectId;
  const worktreeId = snapshot.review.worktreeId;

  const loadBrowse = useCallback(async (path?: string) => {
    if (!client) {
      setBrowseStatus("error");
      setBrowse(null);
      setBrowseError("File list unavailable");
      return;
    }
    setBrowseStatus("loading");
    setBrowseError(null);
    let result;
    try {
      result = await client.browseCodingAgentFiles({
        projectId,
        worktreeId,
        ...(path ? { path } : {}),
        limit: 20,
      });
    } catch {
      setBrowseStatus("error");
      setBrowse(null);
      setBrowseError("File list unavailable");
      return;
    }
    if (!result.ok) {
      setBrowseStatus("error");
      setBrowse(null);
      setBrowseError("File list unavailable");
      return;
    }
    setBrowseStatus("ready");
    setBrowse(result.browse);
  }, [client, projectId, worktreeId]);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (!client) {
      setSearchStatus("error");
      setSearchResult(null);
      setSearchError("File search unavailable");
      return;
    }
    setSearchStatus("loading");
    setSearchError(null);
    let result;
    try {
      result = await client.searchCodingAgentFiles({
        projectId,
        worktreeId,
        query: trimmed,
        limit: 20,
      });
    } catch {
      setSearchStatus("error");
      setSearchResult(null);
      setSearchError("File search unavailable");
      return;
    }
    if (!result.ok) {
      setSearchStatus("error");
      setSearchResult(null);
      setSearchError("File search unavailable");
      return;
    }
    setSearchStatus("ready");
    setSearchResult(result.search);
  }, [client, projectId, query, worktreeId]);

  const renderEntry = (
    entry: FileBrowseResponse["entries"]["items"][number],
    source: "file browser" | "search results",
  ) => {
    const isDirectory = entry.kind === "directory";
    const isFile = entry.kind === "file";
    return (
      <View key={`${source}:${entry.path}`} style={styles.fileBrowserRow}>
        <View style={styles.rowIcon}>
          <Ionicons
            name={isDirectory ? "folder-open-outline" : "document-text-outline"}
            size={17}
            color={theme.colors.moss}
          />
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{entry.path}</Text>
          <Text style={styles.rowSubtitle}>{entry.kind}</Text>
        </View>
        {isDirectory ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open directory ${entry.path}`}
            onPress={() => void loadBrowse(entry.path)}
            style={styles.fileBrowserSmallButton}
          >
            <Text style={styles.fileBrowserSmallButtonText}>Open</Text>
          </Pressable>
        ) : null}
        {canReadFiles && isFile ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open file ${entry.path} from ${source}`}
            onPress={() => onOpenFile({ projectId, worktreeId, path: entry.path })}
            style={styles.fileBrowserSmallButton}
          >
            <Text style={styles.fileBrowserSmallButtonText}>Open</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.fileBrowserPanel}>
      <View style={styles.reviewDetailHeader}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>File browser</Text>
          <Text style={styles.rowSubtitle}>{`${projectId} / ${worktreeId}`}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Browse workspace files for review PR #${snapshot.review.pullRequestNumber}`}
          accessibilityState={{ disabled: browseStatus === "loading" }}
          disabled={browseStatus === "loading"}
          onPress={() => void loadBrowse()}
          style={[
            styles.reviewFileOpenButton,
            browseStatus === "loading" ? styles.fileContentSaveButtonDisabled : null,
          ]}
        >
          <Ionicons name="folder-open-outline" size={15} color={theme.colors.background} />
          <Text style={styles.reviewFileOpenText}>{browseStatus === "loading" ? "Loading" : "Browse files"}</Text>
        </Pressable>
      </View>
      <View style={styles.fileBrowserSearchRow}>
        <TextInput
          accessibilityLabel="Search review workspace files"
          value={query}
          onChangeText={(value) => setQuery(value.slice(0, 80))}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.fileBrowserSearchInput}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Run review workspace file search"
          accessibilityState={{ disabled: !query.trim() || searchStatus === "loading" }}
          disabled={!query.trim() || searchStatus === "loading"}
          onPress={() => void runSearch()}
          style={[
            styles.fileBrowserSearchButton,
            !query.trim() || searchStatus === "loading" ? styles.fileContentSaveButtonDisabled : null,
          ]}
        >
          <Ionicons name="search-outline" size={15} color={theme.colors.background} />
          <Text style={styles.reviewFileOpenText}>{searchStatus === "loading" ? "Searching" : "Search"}</Text>
        </Pressable>
      </View>
      {browseStatus === "error" ? <Text style={styles.fileContentError}>{browseError}</Text> : null}
      {browse?.entries.items.map((entry) => renderEntry(entry, "file browser"))}
      {searchStatus === "error" ? <Text style={styles.fileContentError}>{searchError}</Text> : null}
      {searchResult?.matches.items.map((entry) => renderEntry(entry, "search results"))}
    </View>
  );
}

function ReviewSnapshotFileRow({
  file,
  fileIndex,
  selectedReviewId,
  snapshotKey,
  selectedHunk,
  onSelectHunk,
  canReadFiles,
  reviewProjectId,
  reviewWorktreeId,
  fileContentState,
  fileSaveState,
  onOpenFile,
  onSaveFile,
}: {
  file: ReviewSnapshot["files"]["items"][number];
  fileIndex: number;
  selectedReviewId: string;
  snapshotKey: string;
  selectedHunk: SelectedReviewHunk | null;
  onSelectHunk: (hunk: SelectedReviewHunk) => void;
  canReadFiles: boolean;
  reviewProjectId: string;
  reviewWorktreeId: string;
  fileContentState: FileContentState;
  fileSaveState: FileSaveState;
  onOpenFile: (request: FileReadRequest) => void;
  onSaveFile: (request: Omit<FileWriteRequest, "encoding" | "clientRequestId">) => void;
}) {
  const { theme } = useUnistyles();
  const displayPath = safeSnapshotText(file.path, HIDDEN_FILE_PATH);

  return (
    <View style={styles.reviewFileRow}>
      <View style={styles.reviewDetailHeader}>
        <View style={styles.rowIcon}>
          <Ionicons name="document-text-outline" size={17} color={theme.colors.moss} />
        </View>
        <View style={styles.rowText}>
          <Text
            selectable={!SECRET_LIKE_FINDING_TEXT.test(file.path)}
            style={styles.rowTitle}
          >
            {displayPath}
          </Text>
          <Text style={styles.rowSubtitle}>{file.status}</Text>
        </View>
      </View>
      <View style={styles.reviewFileStats}>
        <Text style={styles.reviewAdditionBadge}>{`+${file.additions}`}</Text>
        <Text style={styles.reviewDeletionBadge}>{`-${file.deletions}`}</Text>
        {file.partial ? <Text style={styles.reviewPartialBadge}>Partial file</Text> : null}
      </View>
      {canReadFiles ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open file ${displayPath}`}
          onPress={() => onOpenFile({
            projectId: reviewProjectId,
            worktreeId: reviewWorktreeId,
            path: file.path,
          })}
          style={styles.reviewFileOpenButton}
        >
          <Ionicons name="document-text-outline" size={15} color={theme.colors.background} />
          <Text style={styles.reviewFileOpenText}>Open file</Text>
        </Pressable>
      ) : null}
      {fileContentState.selectedPath === file.path ? (
        <FileContentPanel
          state={fileContentState}
          saveState={fileSaveState}
          projectId={reviewProjectId}
          worktreeId={reviewWorktreeId}
          onSave={onSaveFile}
        />
      ) : null}
      {file.findings?.length ? (
        file.findings.map((finding, findingIndex) => (
          <Text
            key={`${finding.id}:${finding.line}:${findingIndex}`}
            style={[
              styles.reviewFinding,
              finding.severity === "high" ? styles.reviewHighActive : null,
            ]}
          >
            {safeFindingSummary(finding.summary)}
          </Text>
        ))
      ) : (
        <Text style={styles.rowSubtitle}>No findings in this file.</Text>
      )}
      {file.hunks.length ? (
        <View style={styles.reviewHunks}>
          {file.hunks.map((hunk, hunkIndex) => {
            const hunkKey = `${fileIndex}\u0000${file.path}\u0000${hunk.id}\u0000${hunkIndex}`;
            const selected = selectedHunk?.reviewId === selectedReviewId && selectedHunk.snapshotKey === snapshotKey && selectedHunk.key === hunkKey;
            return (
              <View
                key={`${file.path}:${fileIndex}:${hunk.id}:${hunkIndex}`}
                style={[
                  styles.reviewHunkRow,
                  selected ? styles.selectedReviewHunkRow : null,
                ]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Select hunk ${hunkIndex + 1} in ${displayPath}`}
                  accessibilityState={{ selected }}
                  onPress={() => onSelectHunk({
                    reviewId: selectedReviewId,
                    snapshotKey,
                    key: hunkKey,
                    filePath: file.path,
                    hunkId: hunk.id,
                    hunkIndex,
                    oldStart: hunk.oldStart,
                    oldLines: hunk.oldLines,
                    newStart: hunk.newStart,
                    newLines: hunk.newLines,
                  })}
                  style={styles.reviewHunkPressable}
                >
                  <Text style={styles.reviewHunkLabel}>{`Hunk ${hunkIndex + 1}`}</Text>
                  <Text style={styles.reviewHunkRange}>{formatHunkRange(hunk)}</Text>
                  {hunk.partial ? <Text style={styles.reviewHunkPartial}>Partial hunk</Text> : null}
                </Pressable>
                <ReviewDiffLines lines={hunk.lines ?? []} />
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function FileContentPanel({
  state,
  saveState,
  projectId,
  worktreeId,
  onSave,
}: {
  state: FileContentState;
  saveState: FileSaveState;
  projectId: string;
  worktreeId: string;
  onSave: (request: Omit<FileWriteRequest, "encoding" | "clientRequestId">) => void;
}) {
  if (state.status === "loading") {
    return <Text style={styles.reviewDetailNotice}>Loading file...</Text>;
  }
  if (state.status === "error") {
    return <Text style={styles.reviewError}>{state.error}</Text>;
  }
  if (state.status !== "ready") return null;

  return (
    <ReadyFileContentPanel
      key={`${state.file.metadata.path}:${state.file.metadata.etag}`}
      file={state.file}
      saveState={saveState}
      projectId={projectId}
      worktreeId={worktreeId}
      onSave={onSave}
    />
  );
}

function ReadyFileContentPanel({
  file,
  saveState,
  projectId,
  worktreeId,
  onSave,
}: {
  file: FileReadResponse;
  saveState: FileSaveState;
  projectId: string;
  worktreeId: string;
  onSave: (request: Omit<FileWriteRequest, "encoding" | "clientRequestId">) => void;
}) {
  const { theme } = useUnistyles();
  const [draft, setDraft] = useState(file.content);
  const dirty = draft !== file.content;
  const saveDisabled = saveState.status === "saving" || !dirty || file.truncated;
  const displayPath = safeSnapshotText(file.metadata.path, HIDDEN_FILE_PATH);

  return (
    <View style={styles.fileContentPanel}>
      <View style={styles.fileContentHeader}>
        <Text style={styles.fileContentMeta}>{`${file.metadata.sizeBytes} bytes`}</Text>
        <View style={styles.fileContentActions}>
          {saveState.status === "saved" ? <Text style={styles.fileContentSaved}>Saved</Text> : null}
          {file.truncated ? <Text style={styles.fileContentTruncated}>Truncated</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Save file ${displayPath}`}
            accessibilityState={{ disabled: saveDisabled }}
            disabled={saveDisabled}
            onPress={() => onSave({
              projectId,
              worktreeId,
              path: file.metadata.path,
              content: draft,
              baseEtag: file.metadata.etag,
            })}
            style={[
              styles.fileContentSaveButton,
              saveDisabled ? styles.fileContentSaveButtonDisabled : null,
            ]}
          >
            <Ionicons
              name="save-outline"
              size={14}
              color={saveDisabled ? theme.colors.mutedForeground : theme.colors.background}
            />
            <Text style={styles.fileContentSaveText}>{saveState.status === "saving" ? "Saving" : "Save"}</Text>
          </Pressable>
        </View>
      </View>
      <TextInput
        accessibilityLabel={`Edit file ${displayPath}`}
        multiline
        scrollEnabled={false}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        value={draft}
        onChangeText={setDraft}
        style={styles.fileContentInput}
      />
      {saveState.status === "error" ? <Text style={styles.fileContentError}>{saveState.error}</Text> : null}
    </View>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionCount}>{count}</Text>
      </View>
      {children}
    </View>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <Text style={styles.emptyText}>{children}</Text>;
}

const styles = StyleSheet.create((theme, rt) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingTop: rt.insets.top + theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: rt.insets.bottom + 32,
    gap: theme.spacing.lg,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  centerTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 17,
    color: theme.colors.foreground,
  },
  centerBody: {
    maxWidth: 280,
    textAlign: "center",
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    color: theme.colors.mutedForeground,
  },
  retryButton: {
    minHeight: 40,
    borderRadius: 20,
    paddingHorizontal: theme.spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.forest,
  },
  retryText: {
    fontFamily: theme.fonts.sansSemiBold,
    color: theme.colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  headerIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  newRunButton: {
    minHeight: 38,
    borderRadius: 19,
    paddingHorizontal: theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.forest,
  },
  newRunText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.background,
  },
  notificationPanel: {
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    overflow: "hidden",
  },
  notificationRow: {
    minHeight: 56,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  notificationText: {
    flex: 1,
    minWidth: 0,
  },
  notificationError: {
    padding: theme.spacing.sm,
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.destructive,
  },
  title: {
    fontFamily: theme.fonts.displaySemiBold,
    fontSize: 24,
    color: theme.colors.foreground,
  },
  subtitle: {
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    color: theme.colors.mutedForeground,
  },
  section: {
    gap: theme.spacing.sm,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 14,
    color: theme.colors.foreground,
  },
  sectionCount: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  row: {
    minHeight: 68,
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  rowPressed: {
    opacity: 0.82,
  },
  selectedReviewRow: {
    borderColor: theme.colors.forest,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  rowSubtitle: {
    marginTop: 2,
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
    textTransform: "capitalize",
  },
  rowMeta: {
    maxWidth: 108,
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
    color: theme.colors.moss,
    textTransform: "capitalize",
  },
  reviewMeta: {
    alignItems: "flex-end",
    gap: 2,
  },
  reviewHigh: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  reviewHighActive: {
    color: theme.colors.destructive,
  },
  attentionBadge: {
    alignSelf: "flex-start",
    marginTop: theme.spacing.xs,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 11,
    color: theme.colors.moss,
  },
  providerSetupActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  reviewError: {
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    fontFamily: theme.fonts.sans,
    color: theme.colors.destructive,
  },
  reviewDetailPanel: {
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  reviewDetailHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  reviewDetailNotice: {
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.secondary,
    padding: theme.spacing.sm,
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  reviewFileRow: {
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.secondary,
    padding: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  reviewFinding: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  reviewFileStats: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  reviewAdditionBadge: {
    borderRadius: 10,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.forest,
  },
  reviewDeletionBadge: {
    borderRadius: 10,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.destructive,
  },
  reviewPartialBadge: {
    borderRadius: 10,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    fontFamily: theme.fonts.sansMedium,
    fontSize: 11,
    color: theme.colors.mutedForeground,
  },
  reviewFileOpenButton: {
    alignSelf: "flex-start",
    minHeight: 34,
    borderRadius: 17,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    backgroundColor: theme.colors.forest,
  },
  reviewCommitActions: {
    alignItems: "flex-start",
    gap: theme.spacing.sm,
  },
  reviewFileOpenText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.background,
  },
  fileBrowserPanel: {
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.secondary,
    padding: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  fileBrowserRow: {
    minHeight: 48,
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  fileBrowserSmallButton: {
    minHeight: 30,
    borderRadius: 15,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: theme.colors.forest,
  },
  fileBrowserSmallButtonText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.background,
  },
  fileBrowserSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  fileBrowserSearchInput: {
    minHeight: 38,
    flex: 1,
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm,
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.card,
  },
  fileBrowserSearchButton: {
    minHeight: 38,
    borderRadius: 19,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    backgroundColor: theme.colors.forest,
  },
  fileContentPanel: {
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    overflow: "hidden",
  },
  fileContentHeader: {
    minHeight: 34,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  fileContentMeta: {
    flex: 1,
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.mutedForeground,
  },
  fileContentActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
  },
  fileContentSaved: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 11,
    color: theme.colors.forest,
  },
  fileContentTruncated: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 11,
    color: theme.colors.moss,
  },
  fileContentSaveButton: {
    minHeight: 30,
    borderRadius: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: theme.colors.forest,
  },
  fileContentSaveButtonDisabled: {
    backgroundColor: theme.colors.secondary,
  },
  fileContentSaveText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.background,
  },
  fileContentInput: {
    minHeight: 156,
    padding: theme.spacing.sm,
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    textAlignVertical: "top",
    color: theme.colors.foreground,
  },
  fileContentError: {
    paddingHorizontal: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.destructive,
  },
  reviewHunks: {
    gap: theme.spacing.xs,
  },
  reviewHunkRow: {
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    overflow: "hidden",
  },
  selectedReviewHunkRow: {
    borderColor: theme.colors.forest,
    backgroundColor: theme.colors.background,
  },
  reviewHunkPressable: {
    padding: theme.spacing.sm,
    gap: 2,
  },
  reviewHunkLabel: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  reviewHunkRange: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    color: theme.colors.foreground,
  },
  reviewHunkPartial: {
    fontFamily: theme.fonts.sans,
    fontSize: 11,
    color: theme.colors.mutedForeground,
  },
  reviewDiffLines: {
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.secondary,
  },
  reviewDiffLine: {
    minHeight: 24,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  reviewDiffMarker: {
    width: 14,
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.mutedForeground,
  },
  reviewDiffAdded: {
    color: theme.colors.forest,
  },
  reviewDiffRemoved: {
    color: theme.colors.destructive,
  },
  reviewDiffLineNumber: {
    width: 34,
    textAlign: "right",
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.mutedForeground,
  },
  reviewDiffContent: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.foreground,
  },
  reviewFollowUpButton: {
    minHeight: 42,
    borderRadius: 21,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.forest,
  },
  reviewFollowUpText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.background,
  },
  emptyText: {
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    fontFamily: theme.fonts.sans,
    color: theme.colors.mutedForeground,
  },
}));

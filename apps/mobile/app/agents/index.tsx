import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { FileReadRequest, FileReadResponse, PreviewSessionSummary, ReviewSnapshot, ReviewSummary, RuntimeSummary } from "@matrix-os/contracts";
import { useGateway } from "@/app/_layout";
import { CODING_AGENTS_MOBILE_WORKSPACE } from "@/lib/feature-flags";

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

type ReviewSnapshotHunk = ReviewSnapshot["files"]["items"][number]["hunks"][number];
type ReviewSnapshotLine = NonNullable<ReviewSnapshotHunk["lines"]>[number];

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

const INITIAL_FILE_CONTENT_STATE: FileContentState = {
  status: "idle",
  selectedPath: null,
  file: null,
  error: null,
};

const SECRET_LIKE_FINDING_TEXT =
  /(gh[psuor]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9_]{20,}|ya29[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:A3T|AKIA|ASIA)[A-Z0-9]{16}|bearer\s+[A-Za-z0-9._-]{12,}|sk(?:_live|_test)?[_-][A-Za-z0-9_-]{16,})/i;
const HIDDEN_FINDING_SUMMARY = "Finding summary hidden for safety.";
const HIDDEN_REVIEW_NOTICE = "Review notice hidden for safety.";
const HIDDEN_FILE_PATH = "File path hidden for safety.";

function capabilityEnabled(summary: RuntimeSummary, id: string): boolean {
  return summary.capabilities.some((capability) => capability.id === id && capability.enabled);
}

function safeFindingSummary(summary: string): string {
  return SECRET_LIKE_FINDING_TEXT.test(summary) ? HIDDEN_FINDING_SUMMARY : summary;
}

function safeSnapshotText(value: string, fallback: string): string {
  return SECRET_LIKE_FINDING_TEXT.test(value) ? fallback : value;
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
  const [reviewState, setReviewState] = useState<ReviewState>(INITIAL_REVIEW_STATE);
  const [reviewSnapshotState, setReviewSnapshotState] = useState<ReviewSnapshotState>(INITIAL_REVIEW_SNAPSHOT_STATE);
  const [fileContentState, setFileContentState] = useState<FileContentState>(INITIAL_FILE_CONTENT_STATE);
  const [refreshing, setRefreshing] = useState(false);
  const requestGeneration = useRef(0);
  const reviewSnapshotGeneration = useRef(0);
  const fileContentGeneration = useRef(0);
  const selectedReviewIdRef = useRef<string | null>(null);

  const clearFileContent = useCallback(() => {
    fileContentGeneration.current += 1;
    setFileContentState(INITIAL_FILE_CONTENT_STATE);
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
    const result = await client.getCodingAgentFileContent(request);
    if (generation !== fileContentGeneration.current) return;
    if (result.ok) {
      setFileContentState({
        status: "ready",
        selectedPath: request.path,
        file: result.file,
        error: null,
      });
      return;
    }
    setFileContentState({
      status: "error",
      selectedPath: request.path,
      file: null,
      error: "File content unavailable",
    });
  }, [client]);

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

  useEffect(() => {
    setState((current) => (current.summary ? current : INITIAL_STATE));
    void loadSummary();
  }, [loadSummary]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadSummary();
    } finally {
      setRefreshing(false);
    }
  }, [loadSummary]);

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

      <Section title="Providers" count={summary.providers.length}>
        {summary.providers.length === 0 ? <EmptyText>No providers are ready.</EmptyText> : null}
        {summary.providers.map((provider) => (
          <View key={provider.id} style={styles.row}>
            <View style={styles.rowIcon}>
              <Ionicons name="cube-outline" size={18} color={theme.colors.moss} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{provider.displayName}</Text>
              <Text style={styles.rowSubtitle}>{provider.availability.replace(/_/g, " ")}</Text>
            </View>
            <Text style={styles.rowMeta}>{provider.authStatus.replace(/_/g, " ")}</Text>
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
                label: preview.label,
                status: preview.status,
                ...(preview.origin ? { origin: preview.origin } : {}),
                ...(preview.updatedAt ? { updatedAt: preview.updatedAt } : {}),
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
          onSelectReview={selectReview}
          onOpenFile={loadFileContent}
        />
      ) : null}
    </ScrollView>
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
  onSelectReview,
  onOpenFile,
}: {
  canCreate: boolean;
  canReadFiles: boolean;
  state: ReviewState;
  snapshotState: ReviewSnapshotState;
  fileContentState: FileContentState;
  onSelectReview: (reviewId: string) => void;
  onOpenFile: (request: FileReadRequest) => void;
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
        onOpenFile={onOpenFile}
      />
    </Section>
  );
}

function ReviewSnapshotPanel({
  canCreate,
  canReadFiles,
  state,
  fileContentState,
  onOpenFile,
}: {
  canCreate: boolean;
  canReadFiles: boolean;
  state: ReviewSnapshotState;
  fileContentState: FileContentState;
  onOpenFile: (request: FileReadRequest) => void;
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

  return (
    <View style={styles.reviewDetailPanel}>
      <View style={styles.reviewDetailHeader}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{`PR #${state.snapshot.review.pullRequestNumber} review details`}</Text>
          <Text style={styles.rowSubtitle}>{`${state.snapshot.files.items.length} files${state.snapshot.partial ? " - partial" : ""}`}</Text>
        </View>
        <Text style={styles.rowMeta}>{reviewStatusLabel(state.snapshot.review.status)}</Text>
      </View>
      {state.snapshot.safeNotice ? (
        <Text style={styles.reviewDetailNotice}>{safeSnapshotText(state.snapshot.safeNotice, HIDDEN_REVIEW_NOTICE)}</Text>
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
          onOpenFile={onOpenFile}
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
  onOpenFile,
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
  onOpenFile: (request: FileReadRequest) => void;
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
        <FileContentPanel state={fileContentState} />
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

function FileContentPanel({ state }: { state: FileContentState }) {
  if (state.status === "loading") {
    return <Text style={styles.reviewDetailNotice}>Loading file...</Text>;
  }
  if (state.status === "error") {
    return <Text style={styles.reviewError}>{state.error}</Text>;
  }
  if (state.status !== "ready") return null;

  return (
    <View style={styles.fileContentPanel}>
      <View style={styles.fileContentHeader}>
        <Text style={styles.fileContentMeta}>{`${state.file.metadata.sizeBytes} bytes`}</Text>
        {state.file.truncated ? <Text style={styles.fileContentTruncated}>Truncated</Text> : null}
      </View>
      <Text selectable style={styles.fileContentText}>
        {state.file.content}
      </Text>
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
  reviewFileOpenText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.background,
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
  fileContentTruncated: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 11,
    color: theme.colors.moss,
  },
  fileContentText: {
    padding: theme.spacing.sm,
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.foreground,
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

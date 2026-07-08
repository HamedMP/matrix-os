import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ReviewSnapshot, ReviewSummary, RuntimeSummary } from "@matrix-os/contracts";
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

const INITIAL_REVIEW_SNAPSHOT_STATE: ReviewSnapshotState = {
  status: "idle",
  selectedReviewId: null,
  snapshot: null,
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

export default function AgentsScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { client } = useGateway();
  const [state, setState] = useState<ScreenState>(INITIAL_STATE);
  const [reviewState, setReviewState] = useState<ReviewState>(INITIAL_REVIEW_STATE);
  const [reviewSnapshotState, setReviewSnapshotState] = useState<ReviewSnapshotState>(INITIAL_REVIEW_SNAPSHOT_STATE);
  const [refreshing, setRefreshing] = useState(false);
  const requestGeneration = useRef(0);
  const reviewSnapshotGeneration = useRef(0);
  const selectedReviewIdRef = useRef<string | null>(null);

  const clearReviewSnapshot = useCallback(() => {
    reviewSnapshotGeneration.current += 1;
    selectedReviewIdRef.current = null;
    setReviewSnapshotState(INITIAL_REVIEW_SNAPSHOT_STATE);
  }, []);

  const loadReviewSnapshot = useCallback(async (reviewId: string) => {
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

      <Section title="Active Threads" count={summary.activeThreads.items.length}>
        {summary.activeThreads.items.length === 0 ? <EmptyText>No active threads.</EmptyText> : null}
        {summary.activeThreads.items.map((thread) => (
          <View key={thread.id} style={styles.row}>
            <View style={styles.rowIcon}>
              <Ionicons name="git-branch-outline" size={18} color={theme.colors.moss} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{thread.title}</Text>
              <Text style={styles.rowSubtitle}>{thread.providerId}</Text>
            </View>
            <Text style={styles.rowMeta}>{thread.status.replace(/_/g, " ")}</Text>
          </View>
        ))}
      </Section>

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
          state={reviewState}
          snapshotState={reviewSnapshotState}
          onSelectReview={selectReview}
        />
      ) : null}
    </ScrollView>
  );
}

function reviewStatusLabel(status: ReviewSummary["status"]): string {
  return status.replace(/_/g, " ");
}

function ReviewSection({
  state,
  snapshotState,
  onSelectReview,
}: {
  state: ReviewState;
  snapshotState: ReviewSnapshotState;
  onSelectReview: (reviewId: string) => void;
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
      <ReviewSnapshotPanel state={snapshotState} />
    </Section>
  );
}

function ReviewSnapshotPanel({ state }: { state: ReviewSnapshotState }) {
  const { theme } = useUnistyles();
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return <Text style={styles.reviewDetailNotice}>Loading review details...</Text>;
  }
  if (state.status === "error") {
    return <Text style={styles.reviewError}>{state.error}</Text>;
  }

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
        <View key={`${file.path}:${fileIndex}`} style={styles.reviewFileRow}>
          <View style={styles.reviewDetailHeader}>
            <View style={styles.rowIcon}>
              <Ionicons name="document-text-outline" size={17} color={theme.colors.moss} />
            </View>
            <View style={styles.rowText}>
              <Text
                selectable={!SECRET_LIKE_FINDING_TEXT.test(file.path)}
                style={styles.rowTitle}
              >
                {safeSnapshotText(file.path, HIDDEN_FILE_PATH)}
              </Text>
              <Text style={styles.rowSubtitle}>{file.status}</Text>
            </View>
          </View>
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
        </View>
      ))}
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

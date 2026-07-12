import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { z } from "zod/v4";
import {
  buildCreateAgentThreadRequestFromComposer,
  defaultAgentThreadComposerDraft,
  type AgentProviderSummary,
  type AgentThreadComposerDraft,
  ProjectIdSchema,
  ProviderIdSchema,
  type RuntimeSummary,
  SafeDisplayStringSchema,
  TaskIdSchema,
  ThreadIdSchema,
} from "@matrix-os/contracts";
import { useGateway } from "@/app/_layout";
import { AgentProjectPicker } from "@/components/agent-project-picker";
import { CODING_AGENTS_MOBILE_WORKSPACE } from "@/lib/feature-flags";

type ScreenState =
  | { status: "loading"; summary: null; error: null }
  | { status: "ready"; summary: RuntimeSummary; error: null }
  | { status: "error"; summary: null; error: "Runtime summary unavailable" };

const INITIAL_STATE: ScreenState = { status: "loading", summary: null, error: null };
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAX_ROUTE_FILE_PATH_LENGTH = 512;

const RouteParamStringSchema = (max: number) => z.preprocess(
  (value) => Array.isArray(value) ? value[0] : value,
  z.string().trim().min(1).max(max),
);

const ReviewHunkSeedParamsSchema = z.object({
  reviewId: RouteParamStringSchema(128)
    .refine((value) => SAFE_REFERENCE.test(value))
    .refine((value) => !value.includes("..")),
  projectId: RouteParamStringSchema(160)
    .refine((value) => SAFE_PROJECT_ID.test(value))
    .refine((value) => !value.includes("..")),
  pullRequestNumber: z.coerce.number().int().positive(),
  round: z.coerce.number().int().positive(),
  maxRounds: z.coerce.number().int().positive(),
  filePath: RouteParamStringSchema(MAX_ROUTE_FILE_PATH_LENGTH)
    .refine((value) => !value.startsWith("/") && !value.includes("\0"))
    .refine((value) => !value.split(/[\\/]+/).some((part) => part === "" || part === "." || part === "..")),
  hunkId: RouteParamStringSchema(128)
    .refine((value) => SAFE_REFERENCE.test(value))
    .refine((value) => !value.includes("..")),
  hunkIndex: z.coerce.number().int().min(0).max(999),
  oldStart: z.coerce.number().int().min(0).max(1_000_000),
  oldLines: z.coerce.number().int().min(0).max(100_000),
  newStart: z.coerce.number().int().min(0).max(1_000_000),
  newLines: z.coerce.number().int().min(0).max(100_000),
}).strict();

type ReviewHunkSeedParams = z.infer<typeof ReviewHunkSeedParamsSchema>;

const ThreadFollowUpSeedParamsSchema = z.object({
  sourceThreadId: z.preprocess(
    (value) => Array.isArray(value) ? value[0] : value,
    ThreadIdSchema,
  ),
  sourceThreadTitle: z.preprocess(
    (value) => Array.isArray(value) ? value[0] : value,
    SafeDisplayStringSchema,
  ),
  sourceProviderId: z.preprocess(
    (value) => Array.isArray(value) ? value[0] : value,
    ProviderIdSchema,
  ).optional(),
}).strict();

type ThreadFollowUpSeedParams = z.infer<typeof ThreadFollowUpSeedParamsSchema>;

let requestCounter = 0;

function firstRouteParam(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const [first] = value;
    return typeof first === "string" ? first : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function nextClientRequestId(): string {
  requestCounter += 1;
  return `req_mobile_${Date.now().toString(36)}_${requestCounter}`;
}

function capabilityEnabled(summary: RuntimeSummary, id: string): boolean {
  return summary.capabilities.some((capability) => capability.id === id && capability.enabled);
}

function providerReady(provider: AgentProviderSummary): boolean {
  return provider.availability === "available" &&
    provider.installStatus === "installed" &&
    provider.authStatus === "authenticated";
}

function availableProject(summary: RuntimeSummary, projectId: string | undefined) {
  if (!projectId) return undefined;
  return summary.projects.items.find((project) => project.id === projectId && project.status === "available");
}

function defaultProjectId(summary: RuntimeSummary, requestedProjectId: string | undefined): string | undefined {
  if (requestedProjectId !== undefined) {
    return availableProject(summary, requestedProjectId)?.id;
  }
  const available = summary.projects.items.filter((project) => project.status === "available");
  return available.length === 1 ? available[0]?.id : undefined;
}

function parseReviewHunkSeedParams(params: Record<string, unknown>): ReviewHunkSeedParams | null {
  const parsed = ReviewHunkSeedParamsSchema.safeParse(params);
  return parsed.success ? parsed.data : null;
}

function parseThreadFollowUpSeedParams(params: Record<string, unknown>): ThreadFollowUpSeedParams | null {
  const parsed = ThreadFollowUpSeedParamsSchema.safeParse(params);
  return parsed.success ? parsed.data : null;
}

function formatHunkRange(seed: ReviewHunkSeedParams): string {
  return `@@ -${seed.oldStart},${seed.oldLines} +${seed.newStart},${seed.newLines} @@`;
}

function safeReferenceSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/\.\.+/g, "_").slice(0, 64) || "ref";
}

function reviewHunkFollowUpDraft(summary: RuntimeSummary, seed: ReviewHunkSeedParams): AgentThreadComposerDraft {
  const base = defaultAgentThreadComposerDraft(summary);
  const hunkNumber = seed.hunkIndex + 1;
  return {
    ...base,
    projectId: seed.projectId,
    prompt: [
      "Please follow up on this review hunk.",
      "",
      `Review: PR #${seed.pullRequestNumber}, round ${seed.round} of ${seed.maxRounds}`,
      `Project: ${seed.projectId}`,
      `File: ${seed.filePath}`,
      `Hunk: ${formatHunkRange(seed)}`,
      "",
      "Use the structured reference attached to inspect the current source and propose the smallest safe fix.",
    ].join("\n"),
    attachments: [
      {
        id: `review:${safeReferenceSegment(seed.reviewId)}:hunk:${safeReferenceSegment(seed.hunkId)}`,
        kind: "structured_ref",
        label: `Review hunk ${hunkNumber}`,
        path: seed.filePath,
      },
    ],
  };
}

function threadFollowUpDraft(summary: RuntimeSummary, seed: ThreadFollowUpSeedParams): AgentThreadComposerDraft {
  const base = defaultAgentThreadComposerDraft(summary);
  const sourceProvider = seed.sourceProviderId
    ? summary.providers.find((provider) => provider.id === seed.sourceProviderId)
    : null;
  return {
    ...base,
    providerId: sourceProvider && providerReady(sourceProvider) ? sourceProvider.id : base.providerId,
    prompt: [
      "Please follow up on this agent run.",
      "",
      `Thread: ${seed.sourceThreadId}`,
      `Title: ${seed.sourceThreadTitle}`,
      "",
      "Use the structured reference attached to inspect the current thread state and continue with the smallest safe next step.",
    ].join("\n"),
    attachments: [
      {
        id: `thread:${safeReferenceSegment(seed.sourceThreadId)}`,
        kind: "structured_ref",
        label: "Source thread",
      },
    ],
  };
}

function isUntouchedDefaultDraft(current: AgentThreadComposerDraft, defaultDraft: AgentThreadComposerDraft): boolean {
  return current.providerId === defaultDraft.providerId &&
    current.prompt === defaultDraft.prompt &&
    current.projectId === defaultDraft.projectId &&
    current.taskId === defaultDraft.taskId &&
    current.terminalSessionId === defaultDraft.terminalSessionId &&
    current.worktreeId === defaultDraft.worktreeId &&
    current.mode === defaultDraft.mode &&
    current.approvalPolicy === defaultDraft.approvalPolicy &&
    current.sandboxMode === defaultDraft.sandboxMode &&
    (current.attachments?.length ?? 0) === 0;
}

function mergeSeededDraft(
  current: AgentThreadComposerDraft | null,
  defaultDraft: AgentThreadComposerDraft,
  seededDraft: AgentThreadComposerDraft | null,
): AgentThreadComposerDraft {
  if (!current) return seededDraft ?? defaultDraft;
  if (!seededDraft) return current;
  if (isUntouchedDefaultDraft(current, defaultDraft)) return seededDraft;
  if ((current.attachments?.length ?? 0) > 0) return current;

  if (current.prompt === defaultDraft.prompt) {
    return {
      ...seededDraft,
      providerId: current.providerId,
      mode: current.mode,
      approvalPolicy: current.approvalPolicy,
      sandboxMode: current.sandboxMode,
    };
  }

  return {
    ...current,
    projectId: seededDraft.projectId ?? current.projectId,
    worktreeId: seededDraft.worktreeId ?? current.worktreeId,
    taskId: seededDraft.taskId ?? current.taskId,
    terminalSessionId: seededDraft.terminalSessionId ?? current.terminalSessionId,
    attachments: seededDraft.attachments,
  };
}

export default function AgentComposerScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const routeParams = useLocalSearchParams();
  const { client } = useGateway();
  const insets = useSafeAreaInsets();
  const reviewIdParam = firstRouteParam(routeParams.reviewId);
  const projectIdParam = firstRouteParam(routeParams.projectId);
  const pullRequestNumberParam = firstRouteParam(routeParams.pullRequestNumber);
  const roundParam = firstRouteParam(routeParams.round);
  const maxRoundsParam = firstRouteParam(routeParams.maxRounds);
  const filePathParam = firstRouteParam(routeParams.filePath);
  const hunkIdParam = firstRouteParam(routeParams.hunkId);
  const hunkIndexParam = firstRouteParam(routeParams.hunkIndex);
  const oldStartParam = firstRouteParam(routeParams.oldStart);
  const oldLinesParam = firstRouteParam(routeParams.oldLines);
  const newStartParam = firstRouteParam(routeParams.newStart);
  const newLinesParam = firstRouteParam(routeParams.newLines);
  const sourceThreadIdParam = firstRouteParam(routeParams.sourceThreadId);
  const sourceThreadTitleParam = firstRouteParam(routeParams.sourceThreadTitle);
  const sourceProviderIdParam = firstRouteParam(routeParams.sourceProviderId);
  const requestedProjectIdResult = ProjectIdSchema.safeParse(projectIdParam);
  const requestedTaskIdResult = TaskIdSchema.safeParse(firstRouteParam(routeParams.taskId));
  const requestedProjectId = requestedProjectIdResult.success ? requestedProjectIdResult.data : undefined;
  const requestedTaskId = requestedTaskIdResult.success ? requestedTaskIdResult.data : undefined;
  const reviewHunkSeed = useMemo(() => parseReviewHunkSeedParams({
    reviewId: reviewIdParam,
    projectId: projectIdParam,
    pullRequestNumber: pullRequestNumberParam,
    round: roundParam,
    maxRounds: maxRoundsParam,
    filePath: filePathParam,
    hunkId: hunkIdParam,
    hunkIndex: hunkIndexParam,
    oldStart: oldStartParam,
    oldLines: oldLinesParam,
    newStart: newStartParam,
    newLines: newLinesParam,
  }), [
    reviewIdParam,
    projectIdParam,
    pullRequestNumberParam,
    roundParam,
    maxRoundsParam,
    filePathParam,
    hunkIdParam,
    hunkIndexParam,
    oldStartParam,
    oldLinesParam,
    newStartParam,
    newLinesParam,
  ]);
  const threadFollowUpSeed = useMemo(() => parseThreadFollowUpSeedParams({
    sourceThreadId: sourceThreadIdParam,
    sourceThreadTitle: sourceThreadTitleParam,
    sourceProviderId: sourceProviderIdParam,
  }), [
    sourceThreadIdParam,
    sourceThreadTitleParam,
    sourceProviderIdParam,
  ]);
  const [state, setState] = useState<ScreenState>(INITIAL_STATE);
  const [draft, setDraft] = useState<AgentThreadComposerDraft | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectMode, setProjectMode] = useState<"scratch" | "github">("scratch");
  const [projectInput, setProjectInput] = useState("");
  const [projectCreateStatus, setProjectCreateStatus] = useState<"idle" | "submitting">("idle");
  const [projectCreateError, setProjectCreateError] = useState<string | null>(null);
  const [submitStatus, setSubmitStatus] = useState<"idle" | "submitting">("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const generation = useRef(0);
  const submitInFlight = useRef(false);

  const loadSummary = useCallback(async () => {
    const nextGeneration = generation.current + 1;
    generation.current = nextGeneration;
    if (!CODING_AGENTS_MOBILE_WORKSPACE || !client) {
      setState({ status: "error", summary: null, error: "Runtime summary unavailable" });
      return;
    }

    const result = await client.getCodingAgentRuntimeSummary();
    if (generation.current !== nextGeneration) return;
    if (!result.ok) {
      setState({ status: "error", summary: null, error: "Runtime summary unavailable" });
      return;
    }
    const summary = result.summary;
    setState({ status: "ready", summary, error: null });
    const baseDraft = defaultAgentThreadComposerDraft(summary);
    const selectedProjectId = defaultProjectId(summary, requestedProjectId);
    const defaultDraft: AgentThreadComposerDraft = {
      ...baseDraft,
      projectId: selectedProjectId,
      taskId: selectedProjectId === requestedProjectId ? requestedTaskId : undefined,
    };
    const seededDraftCandidate = reviewHunkSeed
      ? reviewHunkFollowUpDraft(summary, reviewHunkSeed)
      : threadFollowUpSeed
        ? threadFollowUpDraft(summary, threadFollowUpSeed)
        : null;
    const seededProjectId = defaultProjectId(summary, seededDraftCandidate?.projectId ?? requestedProjectId);
    const seededDraft = seededDraftCandidate ? {
      ...seededDraftCandidate,
      projectId: seededProjectId,
      taskId: seededProjectId === requestedProjectId ? requestedTaskId : undefined,
    } : null;
    setDraft((current) => mergeSeededDraft(current, defaultDraft, seededDraft));
  }, [client, requestedProjectId, requestedTaskId, reviewHunkSeed, threadFollowUpSeed]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const summary = state.summary;
  const selectedProvider = summary?.providers.find((provider) => provider.id === draft?.providerId);
  const selectedProject = summary && draft ? availableProject(summary, draft.projectId) : undefined;
  const modes = selectedProvider?.supportedModes ?? [];
  const canCreate = Boolean(summary && capabilityEnabled(summary, "codingAgentsThreadCreate"));

  const chooseProvider = useCallback((provider: AgentProviderSummary) => {
    if (!summary) return;
    setDraft((current) => ({
      ...(current ?? defaultAgentThreadComposerDraft(summary)),
      providerId: provider.id,
      mode: provider.defaultMode,
    }));
    setPickerOpen(false);
  }, [summary]);

  const chooseProject = useCallback((projectId: string) => {
    if (!summary || !availableProject(summary, projectId)) return;
    setDraft((current) => ({
      ...(current ?? defaultAgentThreadComposerDraft(summary)),
      projectId,
      taskId: current?.projectId === projectId ? current.taskId : undefined,
    }));
    setProjectPickerOpen(false);
    setCreateError(null);
  }, [summary]);

  const createProject = useCallback(async () => {
    if (!client || projectCreateStatus === "submitting") return;
    const value = projectInput.trim();
    if (!value) {
      setProjectCreateError(projectMode === "scratch"
        ? "Enter a project name."
        : "Enter a GitHub repository URL.");
      return;
    }
    setProjectCreateStatus("submitting");
    setProjectCreateError(null);
    try {
      const result = await client.createProject(projectMode === "scratch"
        ? { mode: "scratch", name: value }
        : { mode: "github", url: value });
      if (!result.ok) {
        setProjectCreateError(result.error);
        return;
      }
      const refreshed = await client.getCodingAgentRuntimeSummary();
      if (!refreshed.ok) {
        setProjectCreateError("Project was created, but the project list could not be refreshed.");
        return;
      }
      const project = availableProject(refreshed.summary, result.projectId);
      if (!project) {
        setProjectCreateError("Project was created, but it is not ready yet. Reopen the composer to retry.");
        return;
      }
      setState({ status: "ready", summary: refreshed.summary, error: null });
      setDraft((current) => ({
        ...(current ?? defaultAgentThreadComposerDraft(refreshed.summary)),
        projectId: project.id,
        taskId: undefined,
      }));
      setProjectInput("");
    } finally {
      setProjectCreateStatus("idle");
    }
  }, [client, projectCreateStatus, projectInput, projectMode]);

  const submit = useCallback(async () => {
    if (submitInFlight.current) return;
    if (!client || !summary || !draft) {
      setCreateError("Agent run could not be started. Try again.");
      return;
    }
    if (!selectedProject) {
      setCreateError("Choose a project before starting an agent run.");
      return;
    }
    const built = buildCreateAgentThreadRequestFromComposer({
      draft,
      summary,
      clientRequestId: nextClientRequestId(),
    });
    if (!built.ok) {
      setCreateError(built.issues[0]?.safeMessage ?? "Agent run could not be started. Try again.");
      return;
    }

    submitInFlight.current = true;
    setSubmitStatus("submitting");
    setCreateError(null);
    try {
      const result = await client.createCodingAgentThread(built.request);
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      router.push({
        pathname: "/agents/[threadId]",
        params: { threadId: result.snapshot.thread.id },
      });
    } finally {
      submitInFlight.current = false;
      setSubmitStatus("idle");
    }
  }, [client, draft, router, selectedProject, summary]);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.forest} />
        <Text style={styles.centerTitle}>Loading composer...</Text>
      </View>
    );
  }

  if (state.status === "error" || !summary || !draft) {
    return (
      <View style={styles.centered}>
        <Ionicons name="warning-outline" size={28} color={theme.colors.moss} />
        <Text selectable style={styles.centerTitle}>{state.error ?? "Runtime summary unavailable"}</Text>
        <Text selectable style={styles.centerBody}>Refresh the workspace or check your selected runtime.</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      accessibilityLabel="Agent composer keyboard area"
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? Math.max(0, insets.top) : 0}
      style={styles.keyboardArea}
    >
      <ScrollView
        style={styles.container}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Ionicons name="sparkles-outline" size={22} color={theme.colors.forest} />
          </View>
          <View style={styles.headerText}>
            <Text style={styles.title}>New agent run</Text>
            <Text style={styles.subtitle}>{summary.runtime.label}</Text>
          </View>
        </View>

        <AgentProjectPicker
          projects={summary.projects.items}
          selectedProjectId={selectedProject?.id}
          taskId={draft.taskId}
          pickerOpen={projectPickerOpen}
          mode={projectMode}
          input={projectInput}
          createStatus={projectCreateStatus}
          createError={projectCreateError}
          onTogglePicker={() => setProjectPickerOpen((open) => !open)}
          onChooseProject={chooseProject}
          onModeChange={(mode) => {
            setProjectMode(mode);
            setProjectCreateError(null);
          }}
          onInputChange={setProjectInput}
          onCreate={() => void createProject()}
        />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Provider</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Provider ${selectedProvider?.displayName ?? "None"}`}
            disabled={!canCreate}
            onPress={() => setPickerOpen((open) => !open)}
            style={styles.providerButton}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{selectedProvider?.displayName ?? "Choose provider"}</Text>
              <Text style={styles.rowSubtitle}>{selectedProvider?.availability.replace(/_/g, " ") ?? "Not selected"}</Text>
            </View>
            <Ionicons name={pickerOpen ? "chevron-up" : "chevron-down"} size={18} color={theme.colors.moss} />
          </Pressable>
          {pickerOpen ? (
            <View accessibilityLabel="Provider picker" style={styles.pickerSheet}>
              {summary.providers.map((provider) => (
                <Pressable
                  key={provider.id}
                  accessibilityRole="button"
                  accessibilityLabel={provider.displayName}
                  disabled={!providerReady(provider)}
                  onPress={() => chooseProvider(provider)}
                  style={[
                    styles.providerOption,
                    provider.id === draft.providerId && styles.providerOptionActive,
                    !providerReady(provider) && styles.providerOptionDisabled,
                  ]}
                >
                  <Text style={styles.rowTitle}>{provider.displayName}</Text>
                  <Text style={styles.rowSubtitle}>
                    {provider.authStatus.replace(/_/g, " ")}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Mode</Text>
          <View style={styles.modeRow}>
            {modes.map((mode) => (
              <Pressable
                key={mode}
                accessibilityRole="button"
                accessibilityLabel={`Mode ${mode}`}
                onPress={() => setDraft((current) => current ? { ...current, mode } : current)}
                style={[styles.modeButton, draft.mode === mode && styles.modeButtonActive]}
              >
                <Text style={[styles.modeText, draft.mode === mode && styles.modeTextActive]}>
                  {mode.replace(/_/g, " ")}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Prompt</Text>
          <TextInput
            accessibilityLabel="Agent run prompt"
            multiline
            value={draft.prompt}
            editable={canCreate}
            onChangeText={(prompt) => setDraft((current) => current ? { ...current, prompt } : current)}
            placeholder="Describe the work to run"
            placeholderTextColor={theme.colors.mutedForeground}
            style={styles.promptInput}
          />
        </View>

        {createError ? <Text selectable style={styles.errorText}>{createError}</Text> : null}
        {!canCreate ? (
          <Text selectable style={styles.errorText}>Agent runs are not available on this runtime yet.</Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start run"
          disabled={!canCreate || submitStatus === "submitting"}
          onPress={() => void submit()}
          style={[styles.startButton, (!canCreate || submitStatus === "submitting") && styles.startButtonDisabled]}
        >
          <Ionicons name="play-outline" size={18} color={theme.colors.background} />
          <Text style={styles.startButtonText}>
            {submitStatus === "submitting" ? "Starting" : "Start run"}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  keyboardArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingTop: theme.spacing.xl,
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  headerIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    borderCurve: "continuous" as const,
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
  sectionTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 14,
    color: theme.colors.foreground,
  },
  providerButton: {
    minHeight: 62,
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  pickerSheet: {
    borderRadius: 16,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    overflow: "hidden",
  },
  providerOption: {
    padding: theme.spacing.md,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  providerOptionActive: {
    backgroundColor: theme.colors.secondary,
  },
  providerOptionDisabled: {
    opacity: 0.5,
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
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
    textTransform: "capitalize",
  },
  modeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  modeButton: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.card,
  },
  modeButtonActive: {
    backgroundColor: theme.colors.forest,
    borderColor: theme.colors.forest,
  },
  modeText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 13,
    color: theme.colors.foreground,
    textTransform: "capitalize",
  },
  modeTextActive: {
    color: theme.colors.background,
  },
  promptInput: {
    minHeight: 148,
    borderRadius: 16,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    color: theme.colors.foreground,
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    textAlignVertical: "top",
  },
  errorText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 13,
    color: theme.colors.destructive,
  },
  startButton: {
    minHeight: 48,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.forest,
  },
  startButtonDisabled: {
    opacity: 0.56,
  },
  startButtonText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.background,
  },
}));

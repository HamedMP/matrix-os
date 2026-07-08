import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  buildCreateAgentThreadRequestFromComposer,
  defaultAgentThreadComposerDraft,
  type AgentProviderSummary,
  type AgentThreadComposerDraft,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import { useGateway } from "@/app/_layout";
import { CODING_AGENTS_MOBILE_WORKSPACE } from "@/lib/feature-flags";

type ScreenState =
  | { status: "loading"; summary: null; error: null }
  | { status: "ready"; summary: RuntimeSummary; error: null }
  | { status: "error"; summary: null; error: "Runtime summary unavailable" };

const INITIAL_STATE: ScreenState = { status: "loading", summary: null, error: null };

let requestCounter = 0;

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

export default function AgentComposerScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { client } = useGateway();
  const [state, setState] = useState<ScreenState>(INITIAL_STATE);
  const [draft, setDraft] = useState<AgentThreadComposerDraft | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
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
    setDraft((current) => current ?? defaultAgentThreadComposerDraft(summary));
  }, [client]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const summary = state.summary;
  const selectedProvider = summary?.providers.find((provider) => provider.id === draft?.providerId);
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

  const submit = useCallback(async () => {
    if (submitInFlight.current) return;
    if (!client || !summary || !draft) {
      setCreateError("Agent run could not be started. Try again.");
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
  }, [client, draft, router, summary]);

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
  );
}

const styles = StyleSheet.create((theme, rt) => ({
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

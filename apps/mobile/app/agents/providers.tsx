import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { CodingAgentNotificationPreferences, CodingAgentNotificationPreferencesUpdate, RuntimeSummary, SafeSetupAction } from "@matrix-os/contracts";
import { useGateway } from "@/app/_layout";
import type { GatewayClient } from "@/lib/gateway-client";
import { EmptyText, Section } from "@/components/agents/agent-workspace-shared";
import { useRuntimeSummary } from "@/lib/use-runtime-summary";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";
import { capture } from "@/lib/analytics";

function triggerSelectionHaptic(): void {
  if (process.env.EXPO_OS !== "ios" || typeof Haptics.selectionAsync !== "function") return;
  void Haptics.selectionAsync().catch((error: unknown) => {
    console.warn("[mobile] selection haptic unavailable", error instanceof Error ? error.name : "unknown");
  });
}

type NotificationPreferencesState =
  | { status: "idle"; preferences: null; error: null }
  | { status: "loading"; preferences: null; error: null }
  | { status: "ready"; preferences: CodingAgentNotificationPreferences; error: null }
  | { status: "saving"; preferences: CodingAgentNotificationPreferences; error: null }
  | { status: "error"; preferences: CodingAgentNotificationPreferences | null; error: "Notification settings unavailable" | "Notification settings could not be saved. Try again." };

type SummaryProvider = RuntimeSummary["providers"][number];

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
  { key: "completed", label: "Completion alerts", detail: "Runs that finish successfully" },
];

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

export default function ProvidersScreen() {
  const { theme } = useUnistyles();
  const { client } = useGateway();
  const router = useRouter();
  const [notificationPreferencesState, setNotificationPreferencesState] = useState<NotificationPreferencesState>(INITIAL_NOTIFICATION_PREFERENCES_STATE);
  const notificationPreferencesGeneration = useRef(0);
  const notificationPreferencesRef = useRef<CodingAgentNotificationPreferences | null>(null);
  const notificationPreferenceSaveActiveRef = useRef(false);
  const pendingNotificationPreferencePatchRef = useRef<Partial<CodingAgentNotificationPreferences["attentionPush"]>>({});

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

  const { state, refreshing, onRefresh } = useRuntimeSummary(loadNotificationPreferences);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: "Providers" }} />
        <ActivityIndicator color={theme.colors.forest} />
        <Text style={styles.centerTitle}>Loading workspace...</Text>
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: "Providers" }} />
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
  return (
    <ScrollView
      style={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      accessibilityLabel="Refresh agent providers"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.forest} />}
    >
      <Stack.Screen options={{ title: "Providers" }} />
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="construct-outline" size={22} color={theme.colors.forest} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>Providers</Text>
          <Text style={styles.subtitle}>{summary.runtime.label}</Text>
        </View>
      </View>

      <ProviderSetupSection summary={summary} client={client} router={router} />

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
    </ScrollView>
  );
}

type SetupActionStatus = "idle" | "running" | "error";

function setupActionKey(providerId: string, index: number, action: SafeSetupAction): string {
  return `${providerId}:${index}:${action.id}:${action.kind}`;
}

function ProviderSetupSection({
  summary,
  client,
  router,
}: {
  summary: RuntimeSummary;
  client: GatewayClient | null;
  router: ReturnType<typeof useRouter>;
}) {
  const { theme } = useUnistyles();
  const providers = setupRequiredProviders(summary);
  const [actionStatuses, setActionStatuses] = useState<Record<string, SetupActionStatus>>({});

  // Runs a provider setup action through the sanctioned surfaces: settings
  // actions route to the in-app Settings tab; terminal actions create a bounded
  // foreground shell session that runs the setup command server-side, then hand
  // off to the terminal tab by session name. The command is never stored in
  // shell state or rendered in the UI.
  const runSetupAction = useCallback(async (action: SafeSetupAction, key: string) => {
    triggerSelectionHaptic();
    // Action kind only — never the setup command.
    capture("provider_setup_started", { action_kind: action.kind });
    if (action.kind === "open_settings") {
      router.push("/(tabs)/settings");
      return;
    }
    if (!client || typeof client.createProviderSetupSession !== "function") {
      setActionStatuses((prev) => ({ ...prev, [key]: "error" }));
      return;
    }
    setActionStatuses((prev) => ({ ...prev, [key]: "running" }));
    const sessionName = await client.createProviderSetupSession(action.command);
    if (!sessionName) {
      setActionStatuses((prev) => ({ ...prev, [key]: "error" }));
      return;
    }
    try {
      const saved = await loadMobileShellState();
      await saveMobileShellState({
        ...saved,
        mode: "terminal",
        lastActiveTerminalSessionId: sessionName,
        terminalHandoffSessionId: sessionName,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      setActionStatuses((prev) => ({ ...prev, [key]: "error" }));
      return;
    }
    setActionStatuses((prev) => ({ ...prev, [key]: "idle" }));
    router.push("/terminal");
  }, [client, router]);

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
                {provider.setupActions.map((action, index) => {
                  const key = setupActionKey(provider.id, index, action);
                  const status = actionStatuses[key] ?? "idle";
                  const running = status === "running";
                  return (
                    <View key={key} style={styles.setupActionItem}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${action.label} for ${provider.displayName}`}
                        accessibilityState={running ? { disabled: true, busy: true } : undefined}
                        disabled={running}
                        onPress={() => void runSetupAction(action, key)}
                        style={({ pressed }) => [
                          styles.setupActionButton,
                          pressed ? styles.setupActionButtonPressed : null,
                        ]}
                      >
                        {running ? (
                          <ActivityIndicator size="small" color={theme.colors.moss} />
                        ) : (
                          <Ionicons
                            name={action.kind === "open_settings" ? "settings-outline" : "terminal-outline"}
                            size={13}
                            color={theme.colors.moss}
                          />
                        )}
                        <Text style={styles.setupActionLabel}>{action.label}</Text>
                      </Pressable>
                      {status === "error" ? (
                        <Text style={styles.setupActionError}>Setup could not start. Try again.</Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
          <Text style={styles.rowMeta}>Setup</Text>
        </View>
      ))}
    </Section>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingTop: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: 32,
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
  providerSetupActions: {
    marginTop: theme.spacing.xs,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  setupActionItem: {
    alignSelf: "flex-start",
    gap: 4,
  },
  setupActionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 32,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
  },
  setupActionButtonPressed: {
    opacity: 0.7,
  },
  setupActionLabel: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 11,
    color: theme.colors.moss,
  },
  setupActionError: {
    fontFamily: theme.fonts.sans,
    fontSize: 11,
    color: theme.colors.destructive,
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
}));

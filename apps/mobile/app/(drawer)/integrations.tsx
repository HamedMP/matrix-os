import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import { useFocusEffect, useRouter } from "expo-router";

import { buildIntegrationSections, integrationDescription, integrationAuthType, type GmailConnectionMethod } from "@matrix-os/contracts/integration-marketplace";
import { GmailConnectionChoice, type GmailChoiceState } from "@/components/integrations/GmailConnectionChoice";
import { IntegrationLogo } from "@/components/integrations/IntegrationLogo";
import {
  SearchField,
  ListRow,
  ListRowSkeletonStack,
  ListRowStack,
} from "@/components/shell/Controls";
import { Page } from "@/components/shell/Page";
import { Icon, Spacer } from "@/components/ui";
import { useComputerIntegrations } from "@/lib/queries/use-computer-integrations";
import type { IntegrationService } from "@/lib/requests";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

export default function IntegrationsScreen() {
  const [query, setQuery] = useState("");
  const [oauthOnly, setOauthOnly] = useState(false);
  const [expandedSections, setExpandedSections] = useState<string[]>([]);
  const [connectedOnly, setConnectedOnly] = useState(false);
  const router = useRouter();
  const { theme } = useUnistyles();
  const {
    connectionContextKey,
    available,
    connected,
    isPending,
    isError,
    startConnection,
    gmailConnectionOptions,
    syncConnections,
    connectingServiceId: startingServiceId,
    refresh,
  } = useComputerIntegrations();
  const pullToRefresh = usePullToRefresh(refresh);
  const [connectingServiceId, setConnectingServiceId] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const previousConnectionIds = useRef(new Set<string>());
  const syncConnectionsRef = useRef(syncConnections);
  const syncInFlight = useRef(false);
  const connectInFlight = useRef(false);
  const [gmailChoice, setGmailChoice] = useState<GmailChoiceState | null>(null);
  const gmailAttempt = useRef(0);
  useEffect(() => {
    gmailAttempt.current += 1;
    connectInFlight.current = false;
    setGmailChoice(null);
    setConnectingServiceId(null);
    return () => { gmailAttempt.current += 1; };
  }, [connectionContextKey]);
  syncConnectionsRef.current = syncConnections;
  const servicesById = new Map(available.map((service) => [service.id, service]));
  const catalogSections = buildIntegrationSections(available, { query, oauthOnly, connectedOnly, connectedIds: connected.map(c => c.service) });
  const connectedLabel = isPending
    ? "Loading connected accounts…"
    : `${connected.length} connected ${connected.length === 1 ? "account" : "accounts"}`;

  const connectIntegration = async (service: IntegrationService, connectionMethod?: GmailConnectionMethod) => {
    if (connectingServiceId || startingServiceId || connectInFlight.current) return;
    connectInFlight.current = true;
    const attempt = gmailAttempt.current;
    setConnectionError(null);
    previousConnectionIds.current = new Set(connected.map((connection) => connection.id));
    try {
      const url = await (connectionMethod ? startConnection(service.id, { connectionMethod }) : startConnection(service.id));
      if (gmailAttempt.current !== attempt) return;
      setConnectingServiceId(service.id);
      await Linking.openURL(url);
    } catch (error: unknown) {
      console.warn("[integrations] Connection unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (gmailAttempt.current !== attempt) return;
      setConnectingServiceId(null);
      setConnectionError("Could not start connection. Try again.");
    } finally {
      if (gmailAttempt.current === attempt) connectInFlight.current = false;
    }
  };

  const cancelGmailChoice = () => {
    gmailAttempt.current += 1;
    connectInFlight.current = false;
    setGmailChoice(null);
  };
  const requestConnection = async (service: IntegrationService) => {
    if (service.id !== "gmail") return connectIntegration(service);
    if (connectingServiceId || startingServiceId || connectInFlight.current) return;
    const attempt = ++gmailAttempt.current;
    connectInFlight.current = true;
    setGmailChoice({ loading: true, error: false, options: null });
    try {
      const options = await gmailConnectionOptions();
      if (gmailAttempt.current !== attempt) return;
      connectInFlight.current = false;
      if (options.methods.length === 1 && options.methods[0] === "pipedream") {
        setGmailChoice(null);
        await connectIntegration(service, "pipedream");
      } else setGmailChoice({ loading: false, error: false, options });
    } catch (error: unknown) {
      console.warn("[integrations] Gmail connection options unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (gmailAttempt.current === attempt) setGmailChoice({ loading: false, error: true, options: null });
    } finally {
      if (gmailAttempt.current === attempt) connectInFlight.current = false;
    }
  };

  useFocusEffect(
    useCallback(() => {
      void Promise.resolve().then(() => syncConnectionsRef.current()).catch((error: unknown) => {
        // Best-effort reconciliation also covers a remount caused by the deep link.
        console.warn("[mobile] integrations focus sync failed", error instanceof Error ? error.name : "unknown");
      });
    }, []),
  );

  useEffect(() => {
    if (!connectingServiceId) return;
    const connectedAfterStart = connected.some(
      (connection) => connection.service === connectingServiceId
        && !previousConnectionIds.current.has(connection.id),
    );
    if (connectedAfterStart) setConnectingServiceId(null);
  }, [connected, connectingServiceId]);

  useEffect(() => {
    if (!connectingServiceId) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const sync = async () => {
      if (cancelled || syncInFlight.current || AppState.currentState !== "active") return;
      syncInFlight.current = true;
      try {
        await syncConnectionsRef.current();
      } catch (error: unknown) {
        // The next poll retries; a delayed provider account is expected during OAuth.
        console.warn("[mobile] integrations poll sync failed", error instanceof Error ? error.name : "unknown");
      } finally {
        syncInFlight.current = false;
      }
    };
    const schedulePoll = () => {
      pollTimer = setTimeout(async () => {
        await sync();
        if (!cancelled) schedulePoll();
      }, 2_000);
    };
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    const timeout = setTimeout(() => setConnectingServiceId(null), 120_000);
    schedulePoll();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      clearTimeout(timeout);
      appStateSubscription.remove();
    };
  }, [connectingServiceId]);

  return (
    <Page
      title="Connect Apps"
      subtitle="Connect apps to let Matrix work across your tools"
      refreshing={pullToRefresh.refreshing}
      onRefresh={pullToRefresh.onRefresh}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="View installed integrations"
        onPress={() => router.push("/integrations-installed" as never)}
        style={({ pressed }) => [styles.installedCard, pressed && styles.pressed]}
      >
        <Spacer size="lg" />
        <View>
          <Text style={styles.cardEyebrow}>Connected apps</Text>
          <Spacer size="xs" />
          <Text style={styles.cardTitle}>{connectedLabel}</Text>
        </View>
        <Spacer size="lg" />
        <View style={styles.installedRow}>
          <View style={styles.iconStack}>
            {connected.slice(0, 4).map((connection, index) => {
              const service = servicesById.get(connection.service) ?? fallbackService(connection.service);
              return (
                <View key={connection.id} style={index === 0 ? undefined : styles.stackedIcon}>
                  <IntegrationLogo service={service} compact />
                </View>
              );
            })}
          </View>
          <Icon icon={ArrowRight01Icon} size={20} color={theme.v2.appColors.ink} />
        </View>
        <Spacer size="lg" />
      </Pressable>

      <Spacer size="2xl" />
      <SearchField placeholder="Search apps" value={query} onChangeText={setQuery} />
      <Spacer size="md" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: !connectedOnly }} onPress={() => setConnectedOnly(false)} style={styles.filter}><Text style={styles.statusText}>All apps</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: connectedOnly }} onPress={() => setConnectedOnly(true)} style={styles.filter}><Text style={styles.statusText}>Connected</Text></Pressable>
        <Pressable accessibilityRole="checkbox" accessibilityLabel="Sign in without API keys" accessibilityState={{ checked: oauthOnly }} onPress={() => setOauthOnly(value => !value)} style={styles.filter}><Text style={styles.statusText}>{oauthOnly ? "✓ " : ""}Sign in without API keys</Text></Pressable>
      </View>
      <Spacer size="md" />
      {isPending ? <ListRowSkeletonStack testID="integration-row-skeleton" /> : null}
      {isError ? <Text style={styles.statusText}>Integrations unavailable. Try again.</Text> : null}
      {connectionError ? (
        <>
          <Text style={styles.errorText}>{connectionError}</Text>
          <Spacer size="md" />
        </>
      ) : null}
      {!isPending && !isError && available.length === 0 ? (
        <Text style={styles.statusText}>No integrations available.</Text>
      ) : null}
      {!isPending && !isError && available.length > 0 ? (
        <View>
          {catalogSections.map(section => (
            <View key={section.title}>
              <Spacer size="xl" />
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={styles.sectionLabel}>{section.title}</Text>
                {!query.trim() && !connectedOnly && !oauthOnly && !expandedSections.includes(section.title) && section.services.length > 4 ? <Pressable accessibilityRole="button" accessibilityLabel={`View all ${section.title} apps`} onPress={() => setExpandedSections(previous => [...previous, section.title])}><Text style={styles.statusText}>View all</Text></Pressable> : null}
              </View>
              <Spacer size="md" />
              <ListRowStack>
                {(query.trim() || connectedOnly || oauthOnly || expandedSections.includes(section.title) ? section.services : section.services.slice(0, 4)).map(service => (
                  <ListRow key={service.id} title={service.name}
                    detail={`${integrationDescription(service)} · ${integrationAuthType(service) === "keys" ? "API key required" : integrationAuthType(service) === "oauth" ? "Sign in securely" : "Connect your account"}`}
                    leading={<IntegrationLogo service={service} />}
                    action={<View style={styles.filter}>
                      {startingServiceId === service.id || connectingServiceId === service.id ? <ActivityIndicator color={theme.v2.appColors.muted} size="small" testID={`integration-connect-spinner-${service.id}`} />
                        : <Text style={styles.statusText}>{connected.some(c => c.service === service.id) ? "Add account" : "Connect"}</Text>}
                    </View>}
                    accessibilityLabel={`Connect ${service.name} integration`} onPress={startingServiceId || connectingServiceId || gmailChoice ? undefined : () => void requestConnection(service)} />
                ))}
              </ListRowStack>
            </View>
          ))}
          {catalogSections.length === 0 ? <Text style={styles.statusText}>No integrations found. Try another search or change the filters.</Text> : null}
        </View>
      ) : null}
      <GmailConnectionChoice choice={gmailChoice} onCancel={cancelGmailChoice}
        onRetry={() => { const service = available.find(item => item.id === "gmail"); if (service) void requestConnection(service); }}
        onChoose={method => {
          const service = available.find(item => item.id === "gmail");
          if (!service || gmailChoice?.loading || gmailChoice?.error || !gmailChoice?.options?.methods.includes(method)) return;
          setGmailChoice(null);
          void connectIntegration(service, method);
        }} />
    </Page>
  );
}

function fallbackService(id: string): IntegrationService {
  return { id, name: titleCase(id.replaceAll("_", " ")), category: "developer", icon: "puzzle" };
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const styles = StyleSheet.create((theme) => ({
  filter: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: theme.v2.appColors.surface },
  installedCard: {
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    borderRadius: 20,
    paddingHorizontal: 17,
    backgroundColor: theme.v2.appColors.surface,
  },
  cardEyebrow: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: theme.v2.appColors.muted,
  },
  cardTitle: {
    fontFamily: theme.v2.fonts.display,
    fontSize: 20,
    color: theme.v2.appColors.ink,
  },
  installedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  iconStack: {
    flexDirection: "row",
  },
  stackedIcon: {
    marginLeft: -7,
  },
  sectionLabel: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.1,
    color: theme.v2.appColors.muted,
  },
  statusText: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    color: theme.v2.appColors.muted,
  },
  errorText: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    color: theme.v2.palette.coral[600],
  },
  pressed: {
    opacity: 0.7,
  },
}));

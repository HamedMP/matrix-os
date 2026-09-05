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
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import { useFocusEffect, useRouter } from "expo-router";

import { IntegrationLogo } from "@/components/integrations/IntegrationLogo";
import {
  ListRow,
  ListRowSkeletonStack,
  ListRowStack,
} from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { Icon, Spacer } from "@/components/ui";
import { useComputerIntegrations } from "@/lib/queries/use-computer-integrations";
import type { IntegrationService } from "@/lib/requests";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

export default function IntegrationsScreen() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const {
    available,
    connected,
    isPending,
    isError,
    startConnection,
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
  syncConnectionsRef.current = syncConnections;
  const servicesById = new Map(available.map((service) => [service.id, service]));
  const connectedLabel = isPending
    ? "Loading connected accounts…"
    : `${connected.length} connected ${connected.length === 1 ? "account" : "accounts"}`;

  const connectIntegration = async (service: IntegrationService) => {
    if (connectingServiceId || connectInFlight.current) return;
    connectInFlight.current = true;
    setConnectionError(null);
    previousConnectionIds.current = new Set(connected.map((connection) => connection.id));
    try {
      const url = await startConnection(service.id);
      setConnectingServiceId(service.id);
      await Linking.openURL(url);
    } catch {
      setConnectingServiceId(null);
      setConnectionError("Could not start connection. Try again.");
    } finally {
      connectInFlight.current = false;
    }
  };

  useFocusEffect(
    useCallback(() => {
      void Promise.resolve().then(() => syncConnectionsRef.current()).catch(() => {
        // Best-effort reconciliation also covers a remount caused by the deep link.
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
      } catch {
        // The next poll retries; a delayed provider account is expected during OAuth.
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
    <MockPage
      title="Integrations"
      subtitle="Capabilities Matrix can use on your behalf"
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
          <Text style={styles.cardEyebrow}>CONNECTED</Text>
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
      <Text style={styles.sectionLabel}>AVAILABLE</Text>
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
        <ListRowStack>
          {available.map((service) => (
            <ListRow
              key={service.id}
              title={service.name}
              detail={`${titleCase(service.category)} service`}
              leading={<IntegrationLogo service={service} />}
              actionIcon={Add01Icon}
              action={startingServiceId === service.id || connectingServiceId === service.id ? (
                <ActivityIndicator
                  color={theme.v2.appColors.muted}
                  size="small"
                  testID={`integration-connect-spinner-${service.id}`}
                />
              ) : undefined}
              accessibilityLabel={`Connect ${service.name} integration`}
              onPress={() => void connectIntegration(service)}
            />
          ))}
        </ListRowStack>
      ) : null}
    </MockPage>
  );
}

function fallbackService(id: string): IntegrationService {
  return { id, name: titleCase(id.replaceAll("_", " ")), category: "developer", icon: "puzzle" };
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const styles = StyleSheet.create((theme) => ({
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

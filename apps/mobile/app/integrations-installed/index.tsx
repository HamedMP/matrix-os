import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import { Swipeable } from "react-native-gesture-handler";

import { IntegrationLogo } from "@/components/integrations/IntegrationLogo";
import {
  ListRow,
  ListRowSkeletonStack,
  ListRowStack,
} from "@/components/shell/Controls";
import { Page } from "@/components/shell/Page";
import { ConfirmDialog, Icon, ListItemMotion, SettleIn } from "@/components/ui";
import { useComputerIntegrations } from "@/lib/queries/use-computer-integrations";
import type { ConnectedIntegration, IntegrationService } from "@/lib/requests";
import { showToast } from "@/lib/toast";

export default function InstalledIntegrationsScreen() {
  const [pendingDelete, setPendingDelete] = useState<ConnectedIntegration | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingDeleteSwipeRef = useRef<(() => void) | null>(null);
  const {
    available,
    connected,
    isPending,
    isError,
    refreshConnection,
    deleteConnection,
    isMutating = false,
    refreshingConnectionId = null,
    deletingConnectionId = null,
  } = useComputerIntegrations();
  const servicesById = new Map(available.map((service) => [service.id, service]));


  const refresh = async (connection: ConnectedIntegration) => {
    setActionError(null);
    try {
      await refreshConnection(connection.id);
      return true;
    } catch {
      setActionError("Could not refresh connection. Try again.");
      return false;
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const connectionId = pendingDelete.id;
    const resetSwipe = pendingDeleteSwipeRef.current;
    pendingDeleteSwipeRef.current = null;
    setPendingDelete(null);
    setActionError(null);
    try {
      await deleteConnection(connectionId);
      showToast("Connection deleted");
    } catch {
      setActionError("Could not delete connection. Try again.");
    } finally {
      resetSwipe?.();
    }
  };

  const closeDeletePopup = () => {
    if (isMutating) return;
    pendingDeleteSwipeRef.current?.();
    pendingDeleteSwipeRef.current = null;
    setPendingDelete(null);
  };

  return (
    <Page title="Connected" subtitle="Accounts Matrix can currently access">
      {isPending ? <ListRowSkeletonStack testID="connected-integration-skeleton" /> : null}
      {isError ? <Text style={styles.statusText}>Integrations unavailable. Try again.</Text> : null}
      {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}
      {!isPending && !isError && connected.length === 0 ? (
        <Text style={styles.statusText}>No connected accounts.</Text>
      ) : null}
      {!isPending && !isError && connected.length > 0 ? (
        <SettleIn>
          <ListRowStack>
            {connected.map((connection) => {
              const service = servicesById.get(connection.service) ?? fallbackService(connection.service);
              return (
                <ListItemMotion key={connection.id}>
                  <SwipeableConnectionRow
                    connection={connection}
                    service={service}
                    disabled={Boolean(refreshingConnectionId || deletingConnectionId)}
                    refreshing={refreshingConnectionId === connection.id}
                    deleting={deletingConnectionId === connection.id}
                    onRefresh={() => refresh(connection)}
                    onDelete={(resetSwipe) => {
                      setActionError(null);
                      pendingDeleteSwipeRef.current = resetSwipe;
                      setPendingDelete(connection);
                    }}
                  />
                </ListItemMotion>
              );
            })}
          </ListRowStack>
        </SettleIn>
      ) : null}

      <DeleteConnectionDialog
        connection={pendingDelete}
        serviceName={(connection) => (servicesById.get(connection.service) ?? fallbackService(connection.service)).name}
        busy={isMutating}
        error={actionError}
        onCancel={closeDeletePopup}
        onConfirm={() => void confirmDelete()}
      />
    </Page>
  );
}

function SwipeableConnectionRow({
  connection,
  service,
  disabled,
  refreshing,
  deleting,
  onRefresh,
  onDelete,
}: {
  connection: ConnectedIntegration;
  service: IntegrationService;
  disabled: boolean;
  refreshing: boolean;
  deleting: boolean;
  onRefresh: () => Promise<boolean>;
  onDelete: (resetSwipe: () => void) => void;
}) {
  const swipeableRef = useRef<Swipeable>(null);
  const { theme } = useUnistyles();
  const refreshAndClose = async () => {
    const succeeded = await onRefresh();
    if (succeeded) swipeableRef.current?.close();
  };

  return (
    <Swipeable
      ref={swipeableRef}
      friction={2}
      rightThreshold={36}
      overshootRight={false}
      renderRightActions={() => (
        <View style={styles.swipeActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Refresh ${connection.accountLabel} ${service.name} connection`}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => void refreshAndClose()}
            style={({ pressed }) => [
              styles.swipeButton,
              styles.refreshButton,
              pressed && styles.pressed,
              disabled && styles.disabled,
            ]}
          >
            {refreshing ? (
              <ActivityIndicator
                size="small"
                color={theme.v2.colors.textDefault}
                testID={`integration-refresh-spinner-${connection.id}`}
              />
            ) : (
              <Icon
                icon={RefreshIcon}
                size={24}
                color={theme.v2.colors.textDefault}
                testID={`integration-refresh-icon-${connection.id}`}
              />
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete ${connection.accountLabel} ${service.name} connection`}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => onDelete(() => swipeableRef.current?.close())}
            style={({ pressed }) => [
              styles.swipeButton,
              styles.deleteButton,
              pressed && styles.pressed,
              disabled && styles.disabled,
            ]}
          >
            {deleting ? (
              <ActivityIndicator
                size="small"
                color={theme.v2.mode === "dark" ? theme.v2.palette.coral[400] : theme.v2.palette.coral[700]}
                testID={`integration-delete-spinner-${connection.id}`}
              />
            ) : (
              <Icon
                icon={Delete02Icon}
                size={24}
                color={theme.v2.mode === "dark" ? theme.v2.palette.coral[400] : theme.v2.palette.coral[700]}
                testID={`integration-delete-icon-${connection.id}`}
              />
            )}
          </Pressable>
        </View>
      )}
    >
      <ListRow
        title={service.name}
        detail={connection.accountEmail ?? connection.accountLabel}
        leading={<IntegrationLogo service={service} />}
        actionIcon={CheckmarkCircle02Icon}
      />
    </Swipeable>
  );
}

/** Asks before revoking Matrix's access to a connected account. */
function DeleteConnectionDialog({
  connection,
  serviceName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  connection: ConnectedIntegration | null;
  serviceName: (connection: ConnectedIntegration) => string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // The connection it last asked about, kept while it fades away.
  const [shown, setShown] = useState(connection);
  if (connection && connection !== shown) setShown(connection);
  const drawn = connection ?? shown;
  const account = drawn?.accountEmail ?? drawn?.accountLabel ?? "this account";

  return (
    <ConfirmDialog
      visible={connection !== null}
      title="Delete connection?"
      message={`This revokes Matrix access to ${account} in ${drawn ? serviceName(drawn) : "this service"}.`}
      confirmLabel="Delete"
      confirmAccessibilityLabel="Confirm delete connection"
      dismissAccessibilityLabel="Close delete connection popup"
      destructive
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

function fallbackService(id: string): IntegrationService {
  return {
    id,
    name: id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    category: "developer",
    icon: "puzzle",
  };
}

const styles = StyleSheet.create((theme) => ({
  statusText: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    color: theme.v2.appColors.muted,
  },
  errorText: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 13,
    color: theme.v2.palette.coral[600],
  },
  swipeActions: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "stretch",
    columnGap: 8,
    paddingLeft: 8,
  },
  swipeButton: {
    alignSelf: "stretch",
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 14,
  },
  refreshButton: {
    backgroundColor: theme.v2.colors.chip,
    borderColor: theme.v2.colors.controlOutlineBorder,
  },
  deleteButton: {
    backgroundColor: theme.v2.mode === "dark" ? theme.v2.palette.coral[900] : theme.v2.palette.coral[50],
    borderColor: theme.v2.mode === "dark" ? theme.v2.palette.coral[700] : theme.v2.palette.coral[200],
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
}));

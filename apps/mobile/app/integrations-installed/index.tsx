import { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
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
} from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { Icon, Spacer } from "@/components/ui";
import { useComputerIntegrations } from "@/lib/queries/use-computer-integrations";
import type { ConnectedIntegration, IntegrationService } from "@/lib/requests";

export default function InstalledIntegrationsScreen() {
  const { theme } = useUnistyles();
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
    <MockPage title="Connected" subtitle="Accounts Matrix can currently access">
      {isPending ? <ListRowSkeletonStack testID="connected-integration-skeleton" /> : null}
      {isError ? <Text style={styles.statusText}>Integrations unavailable. Try again.</Text> : null}
      {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}
      {!isPending && !isError && connected.length === 0 ? (
        <Text style={styles.statusText}>No connected accounts.</Text>
      ) : null}
      {!isPending && !isError && connected.length > 0 ? (
        <ListRowStack>
          {connected.map((connection) => {
            const service = servicesById.get(connection.service) ?? fallbackService(connection.service);
            return (
              <SwipeableConnectionRow
                key={connection.id}
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
            );
          })}
        </ListRowStack>
      ) : null}

      <DeleteConnectionPopup
        connection={pendingDelete}
        service={pendingDelete
          ? servicesById.get(pendingDelete.service) ?? fallbackService(pendingDelete.service)
          : null}
        error={actionError}
        isSubmitting={isMutating}
        onClose={closeDeletePopup}
        onConfirm={() => void confirmDelete()}
      />
    </MockPage>
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
                color={theme.v2.palette.green[700]}
                testID={`integration-refresh-spinner-${connection.id}`}
              />
            ) : (
              <Icon
                icon={RefreshIcon}
                size={24}
                color={theme.v2.palette.green[700]}
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
                color={theme.v2.palette.coral[700]}
                testID={`integration-delete-spinner-${connection.id}`}
              />
            ) : (
              <Icon
                icon={Delete02Icon}
                size={24}
                color={theme.v2.palette.coral[700]}
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

function DeleteConnectionPopup({
  connection,
  service,
  error,
  isSubmitting,
  onClose,
  onConfirm,
}: {
  connection: ConnectedIntegration | null;
  service: IntegrationService | null;
  error: string | null;
  isSubmitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      transparent
      animationType="fade"
      visible={connection !== null}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.popupOverlay}
      >
        <Pressable accessibilityLabel="Close delete connection popup" onPress={onClose} style={styles.popupBackdrop} />
        <View style={styles.popupCard}>
          <Spacer size="xl" />
          <Text style={styles.popupTitle}>Delete connection?</Text>
          <Spacer size="sm" />
          <Text style={styles.popupBody}>
            {`This revokes Matrix access to ${connection?.accountEmail ?? connection?.accountLabel ?? "this account"} in ${service?.name ?? "this service"}.`}
          </Text>
          {error ? (
            <>
              <Spacer size="sm" />
              <Text style={styles.errorText}>{error}</Text>
            </>
          ) : null}
          <Spacer size="xl" />
          <View style={styles.popupButtons}>
            <PopupButton label="Cancel" onPress={onClose} disabled={isSubmitting} />
            <PopupButton
              label="Delete"
              accessibilityLabel="Confirm delete connection"
              destructive
              onPress={onConfirm}
              disabled={isSubmitting}
            />
          </View>
          <Spacer size="xl" />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PopupButton({
  label,
  accessibilityLabel,
  destructive = false,
  disabled = false,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.popupButton,
        destructive ? styles.popupButtonDestructive : styles.popupButtonNeutral,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.popupButtonText, destructive && styles.popupButtonTextDestructive]}>{label}</Text>
    </Pressable>
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
    backgroundColor: theme.v2.palette.green[100],
    borderColor: theme.v2.palette.green[200],
  },
  deleteButton: {
    backgroundColor: theme.v2.palette.coral[50],
    borderColor: theme.v2.palette.coral[200],
  },
  popupOverlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  popupBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(13, 12, 12, 0.36)",
  },
  popupCard: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    paddingHorizontal: 20,
    backgroundColor: theme.v2.palette.neutral[50],
    borderWidth: 1,
    borderColor: theme.v2.palette.neutral[300],
    borderRadius: 20,
    shadowColor: theme.v2.palette.neutral[900],
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  popupTitle: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 19,
    color: theme.v2.appColors.ink,
  },
  popupBody: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: theme.v2.appColors.muted,
  },
  popupButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    columnGap: 8,
  },
  popupButton: {
    minWidth: 88,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 12,
  },
  popupButtonNeutral: {
    backgroundColor: theme.v2.palette.neutral[50],
    borderColor: theme.v2.palette.neutral[300],
  },
  popupButtonDestructive: {
    backgroundColor: theme.v2.palette.coral[700],
    borderColor: theme.v2.palette.coral[700],
  },
  popupButtonText: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 14,
    color: theme.v2.appColors.ink,
  },
  popupButtonTextDestructive: {
    color: theme.v2.palette.neutral[50],
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
}));

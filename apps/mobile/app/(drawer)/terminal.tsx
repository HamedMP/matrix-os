import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import ComputerTerminal01Icon from "@hugeicons/core-free-icons/ComputerTerminal01Icon";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ChevronRightIcon from "@hugeicons/core-free-icons/ChevronRightIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import { Swipeable } from "react-native-gesture-handler";

import {
  ListRow,
  ListRowSkeletonStack,
  ListRowStack,
  MockSearchField,
} from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { TerminalAgentLogo, type MobileTerminalAgent } from "@/components/terminal/TerminalAgentLogo";
import { Divider, FloatingActionButton, Icon, Sheet, Spacer } from "@/components/ui";
import { useComputerTerminals } from "@/lib/queries/use-computer-terminals";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import { isValidEditableTerminalSessionName, type TerminalSession } from "@/lib/requests";

type TerminalAction = {
  type: "rename" | "delete";
  session: TerminalSession;
} | null;

const SHEET_DISMISS_NAVIGATION_DELAY_MS = 500;

export default function TerminalScreen() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const [searchQuery, setSearchQuery] = useState("");
  const [terminalAction, setTerminalAction] = useState<TerminalAction>(null);
  const [nextName, setNextName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [manageSheetVisible, setManageSheetVisible] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [createSessionError, setCreateSessionError] = useState<string | null>(null);
  const sessionNavigationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    sessions,
    isPending,
    isError,
    createSession,
    renameSession,
    deleteSession,
    isMutating = false,
    refresh,
  } = useComputerTerminals();
  const pullToRefresh = usePullToRefresh(refresh);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredSessions = normalizedQuery
    ? sessions.filter((session) => session.name.toLowerCase().includes(normalizedQuery))
    : sessions;
  const activeSessions = filteredSessions.filter((session) => session.status !== "exited");
  const closedSessions = filteredSessions.filter((session) => session.status === "exited");

  useEffect(() => () => {
    if (sessionNavigationTimer.current) clearTimeout(sessionNavigationTimer.current);
  }, []);

  const closeAction = () => {
    if (isMutating) return;
    setTerminalAction(null);
    setActionError(null);
  };

  const openRename = (session: TerminalSession) => {
    setNextName(session.name);
    setActionError(null);
    setTerminalAction({ type: "rename", session });
  };

  const openDelete = (session: TerminalSession) => {
    setActionError(null);
    setTerminalAction({ type: "delete", session });
  };

  const submitRename = async () => {
    if (terminalAction?.type !== "rename") return;
    const trimmedName = nextName.trim();
    if (!isValidEditableTerminalSessionName(trimmedName)) {
      setActionError("Use lowercase letters, numbers, and hyphens (31 characters max).");
      return;
    }
    if (trimmedName === terminalAction.session.name) {
      closeAction();
      return;
    }
    setActionError(null);
    try {
      await renameSession(terminalAction.session.name, trimmedName);
      setTerminalAction(null);
    } catch {
      setActionError("Could not rename terminal. Try again.");
    }
  };

  const submitDelete = async () => {
    if (terminalAction?.type !== "delete") return;
    setActionError(null);
    try {
      await deleteSession(terminalAction.session.name);
      setTerminalAction(null);
    } catch {
      setActionError("Could not delete terminal. Try again.");
    }
  };

  const renderSession = (session: TerminalSession) => (
    <SwipeableTerminalRow
      key={session.name}
      session={session}
      onRename={() => openRename(session)}
      onDelete={() => openDelete(session)}
      onPress={() => router.push({
        pathname: "/terminal-session/[session]",
        params: { session: session.name },
      } as never)}
    />
  );

  const submitCreateSession = async () => {
    if (creatingSession) return;
    setCreateSessionError(null);
    setCreatingSession(true);
    try {
      const sessionName = await createSession();
      setManageSheetVisible(false);
      if (sessionNavigationTimer.current) clearTimeout(sessionNavigationTimer.current);
      sessionNavigationTimer.current = setTimeout(() => {
        sessionNavigationTimer.current = null;
        router.push({
          pathname: "/terminal-session/[session]",
          params: { session: sessionName },
        } as never);
      }, SHEET_DISMISS_NAVIGATION_DELAY_MS);
    } catch {
      setCreateSessionError("Could not create terminal. Try again.");
    } finally {
      setCreatingSession(false);
    }
  };

  return (
    <View style={styles.screen}>
      <MockPage
        title="Terminal"
        subtitle="Persistent sessions on this computer"
        refreshing={pullToRefresh.refreshing}
        onRefresh={pullToRefresh.onRefresh}
      >
        <MockSearchField
          placeholder="Search sessions"
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        <Spacer size="2xl" />
        <Text style={styles.sectionLabel}>ACTIVE SESSIONS</Text>
        <Spacer size="md" />

        {isPending ? <ListRowSkeletonStack testID="terminal-row-skeleton" /> : null}
        {isError ? <Text style={styles.statusText}>Terminals unavailable. Try again.</Text> : null}
        {!isPending && !isError && activeSessions.length === 0
          ? <Text style={styles.statusText}>No active terminal sessions.</Text>
          : null}
        {!isPending && !isError && activeSessions.length > 0 ? (
          <ListRowStack>{activeSessions.map(renderSession)}</ListRowStack>
        ) : null}

        {closedSessions.length > 0 ? (
          <>
            <Spacer size="2xl" />
            <Text style={styles.sectionLabel}>CLOSED SESSIONS</Text>
            <Spacer size="md" />
            <ListRowStack>{closedSessions.map(renderSession)}</ListRowStack>
          </>
        ) : null}

        <TerminalActionPopup
          action={terminalAction}
          nextName={nextName}
          error={actionError}
          isSubmitting={isMutating}
          onChangeName={setNextName}
          onClose={closeAction}
          onRename={() => void submitRename()}
          onDelete={() => void submitDelete()}
        />
      </MockPage>
      <FloatingActionButton
        accessibilityLabel="Manage terminals"
        icon={Add01Icon}
        iconTestID="manage-terminals-icon"
        onPress={() => {
          setCreateSessionError(null);
          setManageSheetVisible(true);
        }}
      />
      <Sheet
        visible={manageSheetVisible}
        onClose={() => {
          if (creatingSession) return;
          setManageSheetVisible(false);
          setCreateSessionError(null);
        }}
        testID="terminal-manage-sheet"
      >
        <View style={styles.sheetHeader}>
          <View accessibilityElementsHidden style={styles.sheetHeaderBalance} />
          <Text style={styles.sheetTitle}>Manage terminals</Text>
          <View accessibilityElementsHidden style={styles.sheetHeaderBalance} />
        </View>
        <Spacer size="xl" />
        <Divider testID="terminal-manage-divider" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New session"
          accessibilityState={{ busy: creatingSession, disabled: creatingSession }}
          disabled={creatingSession}
          onPress={() => void submitCreateSession()}
          style={({ pressed }) => [styles.manageOption, pressed && styles.pressed]}
        >
          <Spacer size="lg" />
          <View style={styles.manageOptionContent}>
            <Text style={styles.manageOptionLabel}>New session</Text>
            {creatingSession ? (
              <ActivityIndicator
                testID="new-terminal-session-loading"
                size="small"
                color={theme.v2.colors.textDefault}
              />
            ) : (
              <Icon
                icon={ChevronRightIcon}
                size={22}
                color={theme.v2.colors.textDefault}
                testID="new-terminal-session-chevron"
              />
            )}
          </View>
          <Spacer size="lg" />
        </Pressable>
        {createSessionError ? (
          <>
            <Spacer size="sm" />
            <Text style={styles.createSessionError}>{createSessionError}</Text>
          </>
        ) : null}
        <Spacer size="4xl" />
      </Sheet>
    </View>
  );
}

function SwipeableTerminalRow({
  session,
  onPress,
  onRename,
  onDelete,
}: {
  session: TerminalSession;
  onPress: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const swipeableRef = useRef<Swipeable>(null);
  const { theme } = useUnistyles();
  const triggerAction = (action: () => void) => {
    swipeableRef.current?.close();
    action();
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
            accessibilityLabel={`Rename ${session.name} terminal`}
            onPress={() => triggerAction(onRename)}
            style={({ pressed }) => [styles.swipeButton, styles.renameButton, pressed && styles.pressed]}
          >
            <Icon
              icon={PencilEdit02Icon}
              size={24}
              color={theme.v2.mode === "dark" ? theme.v2.palette.green[400] : theme.v2.palette.green[700]}
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete ${session.name} terminal`}
            onPress={() => triggerAction(onDelete)}
            style={({ pressed }) => [styles.swipeButton, styles.deleteButton, pressed && styles.pressed]}
          >
            <Icon
              icon={Delete02Icon}
              size={24}
              color={theme.v2.mode === "dark" ? theme.v2.palette.coral[400] : theme.v2.palette.coral[700]}
            />
          </Pressable>
        </View>
      )}
    >
      <ListRow
        title={session.name}
        detail={sessionDetail(session)}
        detailLeading={isMobileTerminalAgent(session.agent) ? <TerminalAgentLogo agent={session.agent} /> : undefined}
        icon={ComputerTerminal01Icon}
        accent={sessionAccent(session, theme)}
        accessibilityLabel={`Open ${session.name} terminal`}
        onPress={onPress}
      />
    </Swipeable>
  );
}

function TerminalActionPopup({
  action,
  nextName,
  error,
  isSubmitting,
  onChangeName,
  onClose,
  onRename,
  onDelete,
}: {
  action: TerminalAction;
  nextName: string;
  error: string | null;
  isSubmitting: boolean;
  onChangeName: (value: string) => void;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const renaming = action?.type === "rename";

  return (
    <Modal
      transparent
      animationType="fade"
      visible={action !== null}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.popupOverlay}
      >
        <Pressable accessibilityLabel="Close terminal popup" onPress={onClose} style={styles.popupBackdrop} />
        <View style={styles.popupCard}>
          <Spacer size="xl" />
          <Text style={styles.popupTitle}>
            {renaming ? "Rename terminal session" : "Delete terminal session?"}
          </Text>
          <Spacer size="sm" />
          <Text style={styles.popupBody}>
            {renaming
              ? "Use lowercase letters, numbers, and hyphens."
              : `This permanently deletes “${action?.session.name ?? ""}”, its processes, and its transcript. This can’t be undone.`}
          </Text>
          {renaming ? (
            <>
              <Spacer size="lg" />
              <TextInput
                accessibilityLabel="Terminal session name"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!isSubmitting}
                maxLength={31}
                onChangeText={onChangeName}
                onSubmitEditing={onRename}
                returnKeyType="done"
                selectTextOnFocus
                value={nextName}
                style={styles.popupInput}
              />
            </>
          ) : null}
          {error ? (
            <>
              <Spacer size="sm" />
              <Text style={styles.popupError}>{error}</Text>
            </>
          ) : null}
          <Spacer size="xl" />
          <View style={styles.popupButtons}>
            <PopupButton label="Cancel" onPress={onClose} disabled={isSubmitting} />
            <PopupButton
              accessibilityLabel={renaming ? "Save terminal name" : "Confirm delete terminal"}
              label={renaming ? "Save" : "Delete"}
              destructive={!renaming}
              onPress={renaming ? onRename : onDelete}
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

function isMobileTerminalAgent(agent: TerminalSession["agent"]): agent is MobileTerminalAgent {
  return agent === "claude" || agent === "codex";
}

function sessionAccent(session: TerminalSession, theme: ReturnType<typeof useUnistyles>["theme"]): string {
  const p = theme.v2.palette;
  const dark = theme.v2.mode === "dark";
  if (session.status === "exited") return dark ? p.neutral[700] : p.neutral[200];
  if (session.visualStatus === "running") return dark ? p.green[800] : p.green[100];
  if (session.visualStatus === "waiting") return dark ? p.gold[800] : p.gold[100];
  return dark ? p.neutral[700] : p.neutral[200];
}

function sessionDetail(session: TerminalSession): string {
  if (session.subtitle?.trim()) return session.subtitle.trim();
  const rawLocation = session.cwd?.trim() || session.project?.trim();
  const location = rawLocation
    ? rawLocation === "~" || rawLocation.startsWith("~/")
      ? rawLocation
      : `~/${rawLocation}`
    : "~";
  return session.branch?.trim() ? `${location} · ${session.branch.trim()}` : location;
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  sheetHeaderBalance: {
    width: 32,
    height: 32,
  },
  sheetTitle: {
    flex: 1,
    fontFamily: theme.v2.fonts.medium,
    fontSize: 18,
    color: theme.v2.colors.textDefault,
    textAlign: "center",
  },
  manageOption: {
    alignSelf: "stretch",
  },
  manageOptionContent: {
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  manageOptionLabel: {
    fontFamily: theme.v2.fonts.medium,
    fontSize: 18,
    color: theme.v2.colors.textDefault,
  },
  createSessionError: {
    paddingHorizontal: 16,
    fontFamily: theme.v2.fonts.body,
    fontSize: 13,
    color: theme.v2.palette.coral[600],
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
  renameButton: {
    backgroundColor: theme.v2.mode === "dark" ? theme.v2.palette.green[900] : theme.v2.palette.green[100],
    borderColor: theme.v2.mode === "dark" ? theme.v2.palette.green[700] : theme.v2.palette.green[200],
  },
  deleteButton: {
    backgroundColor: theme.v2.mode === "dark" ? theme.v2.palette.coral[900] : theme.v2.palette.coral[50],
    borderColor: theme.v2.mode === "dark" ? theme.v2.palette.coral[700] : theme.v2.palette.coral[200],
  },
  pressed: {
    opacity: 0.7,
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
  popupInput: {
    height: 48,
    paddingHorizontal: 14,
    fontFamily: theme.v2.fonts.body,
    fontSize: 15,
    color: theme.v2.appColors.ink,
    backgroundColor: theme.v2.palette.green[25],
    borderWidth: 1,
    borderColor: theme.v2.palette.neutral[300],
    borderRadius: 12,
  },
  popupError: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 13,
    color: theme.v2.palette.coral[600],
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
  disabled: {
    opacity: 0.5,
  },
}));

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
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
  SearchField,
} from "@/components/shell/Controls";
import { Page } from "@/components/shell/Page";
import { TabScreen } from "@/components/shell/TabScreen";
import { ItemContextMenu } from "@/components/ItemContextMenu";
import { TerminalAgentLogo, type MobileTerminalAgent } from "@/components/terminal/TerminalAgentLogo";
import {
  ConfirmDialog,
  Divider,
  FloatingActionButton,
  Icon,
  ListItemMotion,
  SettleIn,
  Sheet,
  Spacer,
} from "@/components/ui";
import { useComputerTerminals } from "@/lib/queries/use-computer-terminals";
import { showToast } from "@/lib/toast";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import {
  isValidTerminalSessionName,
  TERMINAL_SESSION_NAME_MAX_LENGTH,
  type TerminalSession,
} from "@/lib/requests";

type TerminalAction = {
  type: "rename" | "delete";
  session: TerminalSession;
} | null;

const SHEET_DISMISS_NAVIGATION_DELAY_MS = 500;
// ListRow's corners, which the row keeps as iOS lifts it for its menu.
const LIST_ROW_RADIUS = 16;
const TERMINAL_NAME_RULE = `Use a name between 1 and ${TERMINAL_SESSION_NAME_MAX_LENGTH} characters.`;

export default function TerminalTab() {
  return (
    <TabScreen>
      <TerminalScreen />
    </TabScreen>
  );
}

function TerminalScreen() {
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
    if (!isValidTerminalSessionName(trimmedName)) {
      setActionError(TERMINAL_NAME_RULE);
      return;
    }
    // The list may have reloaded since the popup opened, most likely because
    // a rename was just refused; the retry has to carry the revision it shows now.
    const session = sessions.find((candidate) => candidate.id === terminalAction.session.id)
      ?? terminalAction.session;
    if (trimmedName === session.name) {
      closeAction();
      return;
    }
    setActionError(null);
    try {
      await renameSession(session, trimmedName);
      setTerminalAction(null);
      showToast("Terminal renamed");
    } catch {
      setActionError("Could not rename terminal. Try again.");
    }
  };

  const submitDelete = async () => {
    if (terminalAction?.type !== "delete") return;
    setActionError(null);
    try {
      await deleteSession(terminalAction.session);
      setTerminalAction(null);
      showToast("Terminal deleted");
    } catch {
      setActionError("Could not delete terminal. Try again.");
    }
  };

  const renderSession = (session: TerminalSession) => (
    <SwipeableTerminalRow
      key={session.id}
      session={session}
      onRename={() => openRename(session)}
      onDelete={() => openDelete(session)}
      onPress={() => router.push({
        pathname: "/terminal-session/[session]",
        params: { session: session.id },
      } as never)}
    />
  );

  const submitCreateSession = async () => {
    if (creatingSession) return;
    setCreateSessionError(null);
    setCreatingSession(true);
    try {
      const sessionId = await createSession();
      setManageSheetVisible(false);
      if (sessionNavigationTimer.current) clearTimeout(sessionNavigationTimer.current);
      sessionNavigationTimer.current = setTimeout(() => {
        sessionNavigationTimer.current = null;
        router.push({
          pathname: "/terminal-session/[session]",
          params: { session: sessionId },
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
      <Page
        title="Terminal"
        subtitle="Persistent sessions on this computer"
        refreshing={pullToRefresh.refreshing}
        onRefresh={pullToRefresh.onRefresh}
      >
        <SearchField
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
          <SettleIn>
            <ListRowStack>
              {activeSessions.map((session) => (
                <ListItemMotion key={session.id}>{renderSession(session)}</ListItemMotion>
              ))}
            </ListRowStack>
          </SettleIn>
        ) : null}

        {closedSessions.length > 0 ? (
          <>
            <Spacer size="2xl" />
            <Text style={styles.sectionLabel}>CLOSED SESSIONS</Text>
            <Spacer size="md" />
            <ListRowStack>
              {closedSessions.map((session) => (
                <ListItemMotion key={session.id}>{renderSession(session)}</ListItemMotion>
              ))}
            </ListRowStack>
          </>
        ) : null}

        <TerminalActionDialog
          action={terminalAction}
          nextName={nextName}
          error={actionError}
          busy={isMutating}
          onChangeName={setNextName}
          onCancel={closeAction}
          onRename={() => void submitRename()}
          onDelete={() => void submitDelete()}
        />
      </Page>
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
              color={theme.v2.colors.textDefault}
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
      {/* The same Rename and Delete as the swipe, from a long press. */}
      <ItemContextMenu
        title={session.name}
        cornerRadius={LIST_ROW_RADIUS}
        actions={[
          { id: "item", key: "rename", label: "Rename", systemImage: "pencil", onSelect: onRename },
          { id: "item", key: "delete", label: "Delete", systemImage: "trash", destructive: true, onSelect: onDelete },
        ]}
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
      </ItemContextMenu>
    </Swipeable>
  );
}

/** Asks for a terminal's new name, or before deleting it. */
function TerminalActionDialog({
  action,
  nextName,
  error,
  busy,
  onChangeName,
  onCancel,
  onRename,
  onDelete,
}: {
  action: TerminalAction;
  nextName: string;
  error: string | null;
  busy: boolean;
  onChangeName: (name: string) => void;
  onCancel: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  // What it last asked about, kept while it fades away after the action is done.
  const [shown, setShown] = useState<TerminalAction>(action);
  if (action && action !== shown) setShown(action);
  const drawn = action ?? shown;
  const renaming = drawn?.type === "rename";

  return (
    <ConfirmDialog
      visible={action !== null}
      title={renaming ? "Rename terminal session" : "Delete terminal session?"}
      message={renaming
        ? TERMINAL_NAME_RULE
        : `This permanently deletes “${drawn?.session.name ?? ""}”, its processes, and its transcript. This can’t be undone.`}
      confirmLabel={renaming ? "Save" : "Delete"}
      confirmAccessibilityLabel={renaming ? "Save terminal name" : "Confirm delete terminal"}
      dismissAccessibilityLabel="Close terminal popup"
      destructive={!renaming}
      busy={busy}
      error={error}
      field={renaming ? {
        accessibilityLabel: "Terminal session name",
        value: nextName,
        onChangeText: onChangeName,
        maxLength: TERMINAL_SESSION_NAME_MAX_LENGTH,
      } : undefined}
      onCancel={onCancel}
      onConfirm={renaming ? onRename : onDelete}
    />
  );
}

function isMobileTerminalAgent(agent: TerminalSession["agent"]): agent is MobileTerminalAgent {
  return agent === "claude" || agent === "codex";
}

function sessionAccent(session: TerminalSession, theme: ReturnType<typeof useUnistyles>["theme"]): string {
  const p = theme.v2.palette;
  const dark = theme.v2.mode === "dark";
  // Only a session that is waiting for the person is coloured; the rest share one neutral.
  if (session.status !== "exited" && session.visualStatus === "waiting") return dark ? p.gold[800] : p.gold[100];
  return dark ? p.neutral[700] : p.neutral[200];
}

function sessionDetail(session: TerminalSession): string {
  const cwd = session.cwd.trim();
  const location = cwd === "" || cwd === "~" || cwd.startsWith("~/") ? cwd || "~" : `~/${cwd}`;
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
}));

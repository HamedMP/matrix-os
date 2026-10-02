import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BotSettingsEmptyState } from "./BotSettingsEmptyState";
import {
  botAccessLabel, botConnectionStateLabel, botServiceLabel, groupBotAuthority,
  type BotAuthorityView, type BotMemoryMutationRequest,
} from "@matrix-os/contracts";

interface BotSettingsSheetProps {
  open: boolean;
  name: string;
  authority: BotAuthorityView;
  actionsAvailable: boolean;
  onClose: () => void;
  onRevoke: (grantId: string) => Promise<unknown>;
  onMemory: (itemId: string, action: "confirm" | "forget", input: BotMemoryMutationRequest) => Promise<unknown>;
  onRefresh: () => Promise<unknown> | void;
}

type Section = "Connections" | "Memory" | "Routines";
type Change = { kind: "revoke" | "confirm" | "forget"; id: string };

/** Native chrome adapts the shared settings model; requests remain owner-authenticated. */
export function BotSettingsSheet({ open, name, authority, actionsAvailable, onClose,
  onRevoke, onMemory, onRefresh }: BotSettingsSheetProps) {
  const [section, setSection] = useState<Section>("Connections");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [changes, setChanges] = useState<Change[]>([]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const currentAuthority = useMemo<BotAuthorityView>(() => ({
    ...authority,
    grants: authority.grants.filter((grant) => !changes.some((change) => change.kind === "revoke" && change.id === grant.grantId)),
    connections: authority.connections.map((connection) => ({ ...connection,
      state: connection.state === "granted"
        && authority.grants.some((grant) => grant.service === connection.service)
        && authority.grants.filter((grant) => grant.service === connection.service)
          .every((grant) => changes.some((change) => change.kind === "revoke" && change.id === grant.grantId))
        ? "connected_not_granted" : connection.state,
    })),
    memory: { ...authority.memory, items: authority.memory.items
      .filter((item) => !changes.some((change) => change.kind === "forget" && change.id === item.itemId))
      .map((item) => ({ ...item, confirmed: item.confirmed
        || changes.some((change) => change.kind === "confirm" && change.id === item.itemId) })) },
  }), [authority, changes]);
  const groups = groupBotAuthority(currentAuthority);
  const unavailable = !actionsAvailable || stale;
  const disabled = pending || unavailable;

  const refresh = async () => {
    await onRefresh();
    if (!mounted.current) return;
    setStale(false);
    setError("");
  };
  const retry = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try { await refresh(); }
    catch (failure: unknown) {
      console.warn("[mobile-bots] Settings refresh failed:", failure instanceof Error ? failure.name : "UnknownError");
      if (mounted.current) {
        setStale(true);
        setError("Bot settings could not be loaded. Try again.");
      }
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const change = async (update: Change, action: () => Promise<unknown>) => {
    if (pendingRef.current || unavailable) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    let saved = false;
    try {
      await action();
      if (!mounted.current) return;
      saved = true;
      // Only confirmed server writes change local visibility. Keep them if refresh fails.
      setChanges((current) => [...current.filter((item) => !(item.kind === update.kind && item.id === update.id)), update].slice(-300));
      await refresh();
    } catch (failure: unknown) {
      console.warn("[mobile-bots] Settings change failed:", failure instanceof Error ? failure.name : "UnknownError");
      if (mounted.current) {
        setStale(saved);
        setError(saved ? "Bot settings could not be loaded. Try again." : "Could not update bot settings. Try again.");
      }
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
    {open ? <View style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss bot settings" style={styles.backdrop} onPress={onClose} />
      <View accessibilityViewIsModal style={styles.sheet}>
        <View style={styles.header}>
          <View style={styles.title}>
            <Text accessibilityRole="header" style={styles.heading}>Bot settings</Text>
            <Text style={styles.muted}>{name}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close bot settings" style={styles.button} onPress={onClose}>
            <Text style={styles.text}>Close</Text>
          </Pressable>
        </View>
        <View accessibilityRole="tablist" style={styles.tabs}>
          {(["Connections", "Memory", "Routines"] as const).map((label) => {
            const count = label === "Connections" ? groups.length
              : label === "Memory" ? currentAuthority.memory.items.length : authority.routines.length;
            return <Pressable key={label} accessibilityRole="tab" accessibilityLabel={`${label} (${count})`}
              accessibilityState={{ selected: section === label }} onPress={() => setSection(label)}
              style={[styles.tab, section === label && styles.selected]}>
              <Text style={styles.text}>{label}</Text><Text style={styles.muted}>{count}</Text>
            </Pressable>;
          })}
        </View>
        {error || unavailable ? <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.text}>{error || "Bot settings could not be loaded. Try again."}</Text>
          {unavailable ? <Pressable accessibilityRole="button" accessibilityLabel="Retry bot settings"
            accessibilityState={{ disabled: pending }} disabled={pending} style={styles.button} onPress={() => void retry()}>
            <Text style={styles.text}>Retry</Text>
          </Pressable> : null}
        </View> : null}
        {pending ? <Text accessibilityLiveRegion="polite" style={styles.muted}>Updating settings…</Text> : null}
        <ScrollView key={section} style={styles.content} contentContainerStyle={styles.group}>
          {section === "Connections" ? <>
            <Text style={styles.muted}>Only the access you&apos;ve allowed for this bot.</Text>
            {!groups.length ? <BotSettingsEmptyState section="connections" /> : null}
            {groups.map((group) => <View key={group.service} style={styles.card}>
              <Text style={styles.heading}>{botServiceLabel(group.service)}</Text>
              <Text style={styles.muted}>{botConnectionStateLabel(group.state)}</Text>
              {group.grants.map((grant) => <View key={grant.grantId} style={styles.account}>
                <View style={styles.title}><Text style={styles.text}>{grant.accountLabel}</Text>
                  <Text style={styles.muted}>{botAccessLabel(grant.effects)}</Text></View>
                <Pressable accessibilityRole="button" accessibilityLabel={`Revoke ${grant.accountLabel}`}
                  accessibilityState={{ disabled }} disabled={disabled} style={styles.button}
                  onPress={() => void change({ kind: "revoke", id: grant.grantId }, () => onRevoke(grant.grantId))}>
                  <Text style={styles.text}>Revoke {grant.accountLabel}</Text>
                </Pressable>
              </View>)}
            </View>)}
          </> : null}
          {section === "Memory" ? <>
            <Text accessibilityRole="header" style={styles.heading}>What your bot remembers</Text>
            <Text style={styles.muted}>Preferences and context saved for this bot. You can forget them anytime.</Text>
            {!currentAuthority.memory.items.length ? <BotSettingsEmptyState section="memory" /> : null}
            {currentAuthority.memory.items.map((item) => <View key={item.itemId} style={styles.card}>
              <Text style={styles.text}>{item.content}</Text>
              <Text style={styles.muted}>{item.source.messageId ? "From Chat" : item.source.url ? "From a web source" : "Remembered"} · {item.source.at.slice(0, 10)}</Text>
              <Text style={styles.muted}>{item.confirmed ? "Confirmed" : "Needs confirmation"}</Text>
              <View style={styles.actions}>
                {!item.confirmed ? <Pressable accessibilityRole="button" accessibilityLabel="Confirm memory"
                  accessibilityState={{ disabled }} disabled={disabled} style={styles.button}
                  onPress={() => void change({ kind: "confirm", id: item.itemId },
                    () => onMemory(item.itemId, "confirm", { baseRevision: item.revision }))}>
                  <Text style={styles.text}>Confirm memory</Text>
                </Pressable> : null}
                <Pressable accessibilityRole="button" accessibilityLabel="Forget memory"
                  accessibilityState={{ disabled }} disabled={disabled} style={styles.button}
                  onPress={() => void change({ kind: "forget", id: item.itemId },
                    () => onMemory(item.itemId, "forget", { baseRevision: item.revision }))}>
                  <Text style={styles.text}>Forget memory</Text>
                </Pressable>
              </View>
            </View>)}
          </> : null}
          {section === "Routines" ? <>
            <Text style={styles.muted}>Scheduled work for this bot.</Text>
            {!authority.routines.length ? <BotSettingsEmptyState section="routines" /> : null}
            {authority.routines.map((routine) => <View key={routine.routineId} style={styles.card}>
              <Text style={styles.text}>{routine.summary}</Text>
              <Text style={styles.muted}>{routine.status === "active" ? "Active" : "Paused"}</Text>
              {routine.nextFireAt ? <Text style={styles.muted}>Next run · {new Date(routine.nextFireAt).toLocaleString()}</Text> : null}
            </View>)}
          </> : null}
        </ScrollView>
      </View>
    </View> : null}
  </Modal>;
}

const styles = StyleSheet.create((theme) => ({
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0, 0, 0, 0.24)" },
  sheet: { height: "78%", backgroundColor: theme.v2.appColors.canvas,
    borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 32, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { flex: 1, gap: 4 },
  heading: { color: theme.colors.foreground, fontWeight: "600", fontSize: 17 },
  text: { color: theme.colors.foreground, fontSize: 14 },
  muted: { color: theme.colors.mutedForeground, fontSize: 13 },
  tabs: { flexDirection: "row", gap: 8 },
  tab: { flex: 1, paddingVertical: 12, alignItems: "center", borderRadius: 12, gap: 4 },
  selected: { backgroundColor: theme.colors.muted },
  content: { flexShrink: 1 },
  group: { gap: 16, paddingBottom: 12 },
  card: { padding: 16, gap: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 16 },
  account: { flexDirection: "row", alignItems: "center", gap: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10 },
  notice: { gap: 8 },
}));

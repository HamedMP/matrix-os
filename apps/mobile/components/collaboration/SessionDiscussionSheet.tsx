import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CollaborationDiscussionMessage, CollaborationScope } from "@matrix-os/contracts/collaboration";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { loadCollaborationDraft, saveCollaborationDraft } from "@/lib/collaboration-drafts";
import {
  fetchSessionDiscussion,
  fetchSessionDiscussionUserState,
  postSessionDiscussion,
  updateSessionDiscussionReadState,
} from "@/lib/requests/collaboration";

export function SessionDiscussionSheet({ open, scope, actorId, getToken, onClose }: {
  open: boolean;
  scope: CollaborationScope;
  actorId: string;
  getToken: () => Promise<string>;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<CollaborationDiscussionMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const draftIdentity = useMemo(() => ({
    actorId, scopeId: scope.id, chatId: scope.resourceId, mode: "discussion" as const,
  }), [actorId, scope.id, scope.resourceId]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        if (!current) return;
        const token = await getToken();
        const [page, userState, savedDraft] = await Promise.all([
          fetchSessionDiscussion(token, scope.id),
          fetchSessionDiscussionUserState(token, scope.id),
          loadCollaborationDraft(AsyncStorage, draftIdentity),
        ]);
        if (!current) return;
        setMessages(page.messages);
        setDraft(savedDraft);
        if (BigInt(page.latestSequence) > BigInt(userState.readThroughSeq)) {
          void updateSessionDiscussionReadState(token, scope.id, page.latestSequence).catch((failure: unknown) => {
            console.warn("[mobile-collaboration] discussion read state failed", failure instanceof Error ? failure.name : "UnknownError");
          });
        }
      } catch (failure: unknown) {
        console.warn("[mobile-collaboration] discussion load failed", failure instanceof Error ? failure.name : "UnknownError");
        if (current) setError(true);
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, [draftIdentity, getToken, open, scope.id]);

  const updateDraft = (text: string) => {
    setDraft(text);
    void saveCollaborationDraft(AsyncStorage, { ...draftIdentity, text }).catch((failure: unknown) => {
      console.warn("[mobile-collaboration] discussion draft save failed", failure instanceof Error ? failure.name : "UnknownError");
    });
  };
  const send = async () => {
    if (!draft.trim() || sending || !scope.capabilities.discuss || scope.role === "viewer") return;
    setSending(true);
    setError(false);
    try {
      const message = await postSessionDiscussion(await getToken(), scope.id, scope.revision, draft.trim(), randomUuid());
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      setDraft("");
      await saveCollaborationDraft(AsyncStorage, { ...draftIdentity, text: "" });
      void updateSessionDiscussionReadState(await getToken(), scope.id, message.sequence).catch((failure: unknown) => {
        console.warn("[mobile-collaboration] discussion read state failed", failure instanceof Error ? failure.name : "UnknownError");
      });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] discussion send failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally {
      setSending(false);
    }
  };
  const readOnly = scope.role === "viewer" || !scope.capabilities.discuss;

  return <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close discussion" style={styles.backdrop} onPress={onClose} />
      <View accessibilityViewIsModal style={styles.sheet}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text accessibilityRole="header" style={styles.title}>Discussion</Text>
            <Text style={styles.muted}>Notes for people in this session—not prompts for AI.</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close discussion panel" onPress={onClose} style={styles.close}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        {loading ? <ActivityIndicator accessibilityLabel="Loading discussion" style={styles.loading} /> : null}
        <FlatList data={messages} keyExtractor={(message) => message.id} contentContainerStyle={styles.messages}
          accessibilityLiveRegion="polite"
          ListEmptyComponent={!loading ? <Text style={styles.empty}>No notes yet.</Text> : null}
          renderItem={({ item }) => <View style={styles.note}>
            <View style={styles.noteHeader}>
              <Text style={styles.author}>{item.actor.displayName}</Text>
              <Text style={styles.time}>{formatTime(item.createdAt)}</Text>
            </View>
            <Text style={styles.body}>{item.text}</Text>
          </View>} />
        <View style={styles.composer}>
          {error ? <Text accessibilityRole="alert" style={styles.error}>Discussion is unavailable. Try again.</Text> : null}
          <TextInput accessibilityLabel="Add a discussion note" multiline value={draft} editable={!readOnly && !sending}
            placeholder={readOnly ? "View-only discussion" : "Add a note for collaborators…"}
            onChangeText={updateDraft} style={styles.input} />
          <Pressable accessibilityRole="button" accessibilityLabel="Post note"
            disabled={readOnly || sending || !draft.trim()} onPress={() => void send()}
            style={({ pressed }) => [styles.post, (pressed || readOnly || sending || !draft.trim()) && styles.faded]}>
            <Text style={styles.postText}>{sending ? "Posting…" : "Post note"}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function randomUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const styles = StyleSheet.create((theme) => ({
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0, 0, 0, 0.24)" },
  sheet: { height: "94%", overflow: "hidden", borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: theme.v2.appColors.canvas },
  header: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.v2.colors.borderSubtle },
  headerCopy: { flex: 1, gap: 2 },
  title: { fontFamily: theme.v2.fonts.semibold, fontSize: 18, color: theme.v2.appColors.ink },
  muted: { fontFamily: theme.v2.fonts.body, fontSize: 12, lineHeight: 17, color: theme.v2.appColors.muted },
  close: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10 },
  closeText: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.action },
  loading: { padding: 20 },
  messages: { flexGrow: 1, gap: 10, padding: 16 },
  empty: { paddingVertical: 48, textAlign: "center", fontFamily: theme.v2.fonts.body, color: theme.v2.appColors.muted },
  note: { gap: 6, padding: 12, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 14, backgroundColor: theme.v2.appColors.surface },
  noteHeader: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  author: { fontFamily: theme.v2.fonts.semibold, fontSize: 13, color: theme.v2.appColors.ink },
  time: { fontFamily: theme.v2.fonts.body, fontSize: 12, color: theme.v2.appColors.muted },
  body: { fontFamily: theme.v2.fonts.body, fontSize: 14, lineHeight: 20, color: theme.v2.appColors.ink },
  composer: { gap: 8, padding: 16, borderTopWidth: 1, borderTopColor: theme.v2.colors.borderSubtle },
  error: { fontFamily: theme.v2.fonts.semibold, fontSize: 13, color: theme.v2.colors.textDefault },
  input: { minHeight: 72, padding: 12, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 14, color: theme.v2.appColors.ink, fontFamily: theme.v2.fonts.body, textAlignVertical: "top" },
  post: { alignSelf: "flex-end", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: theme.v2.palette.green[800] },
  postText: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.textInverse },
  faded: { opacity: 0.5 },
}));

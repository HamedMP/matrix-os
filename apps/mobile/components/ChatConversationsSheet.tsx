import { ActivityIndicator, FlatList, Modal, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ConversationMeta } from "@/lib/gateway-client";
import { formatRelativeAge } from "@/lib/agent-cockpit";

interface ChatConversationsSheetProps {
  visible: boolean;
  loading: boolean;
  conversations: ConversationMeta[];
  activeSessionId: string | null;
  nowMs: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}

export function ChatConversationsSheet({
  visible,
  loading,
  conversations,
  activeSessionId,
  nowMs,
  onSelect,
  onNew,
  onClose,
}: ChatConversationsSheetProps) {
  const { theme } = useUnistyles();

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Conversations</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close conversations"
            onPress={onClose}
            style={({ pressed }) => [styles.closeButton, pressed ? styles.pressed : null]}
          >
            <Ionicons name="close" size={20} color={theme.colors.foreground} />
          </Pressable>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a new conversation"
          onPress={onNew}
          style={({ pressed }) => [styles.newRow, pressed ? styles.pressed : null]}
        >
          <View style={styles.newIcon}>
            <Ionicons name="add" size={18} color={theme.colors.primaryForeground} />
          </View>
          <Text style={styles.newLabel}>New conversation</Text>
        </Pressable>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : conversations.length === 0 ? (
          <View style={styles.centered}>
            <Ionicons name="chatbubbles-outline" size={22} color={theme.colors.mutedForeground} />
            <Text style={styles.emptyTitle}>No recent conversations.</Text>
            <Text style={styles.emptyBody}>Recent chats with your Matrix appear here.</Text>
          </View>
        ) : (
          <FlatList
            data={conversations}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => {
              const selected = item.id === activeSessionId;
              const age = formatRelativeAge(new Date(item.updatedAt).toISOString(), nowMs);
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open conversation ${item.preview || item.id}`}
                  accessibilityState={{ selected }}
                  onPress={() => onSelect(item.id)}
                  style={({ pressed }) => [styles.row, selected ? styles.rowSelected : null, pressed ? styles.pressed : null]}
                >
                  <View style={styles.rowIcon}>
                    <Ionicons
                      name={selected ? "chatbubble" : "chatbubble-outline"}
                      size={17}
                      color={selected ? theme.colors.primary : theme.colors.mutedForeground}
                    />
                  </View>
                  <View style={styles.rowText}>
                    <Text numberOfLines={2} style={styles.rowPreview}>
                      {item.preview.trim() || "New conversation"}
                    </Text>
                    <Text numberOfLines={1} style={styles.rowMeta}>
                      {age ? `${item.messageCount} messages · ${age}` : `${item.messageCount} messages`}
                    </Text>
                  </View>
                  {selected ? <Ionicons name="checkmark" size={17} color={theme.colors.primary} /> : null}
                </Pressable>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.md,
  },
  title: {
    fontFamily: theme.fonts.displaySemiBold,
    fontSize: 22,
    color: theme.colors.foreground,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  newRow: {
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    minHeight: 52,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  newIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primary,
  },
  newLabel: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  listContent: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing["2xl"],
    gap: theme.spacing.xs,
  },
  row: {
    minHeight: 60,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  rowSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.secondary,
  },
  rowIcon: { width: 24, alignItems: "center" },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowPreview: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    lineHeight: 19,
    color: theme.colors.foreground,
  },
  rowMeta: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xl,
  },
  emptyTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  emptyBody: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    textAlign: "center",
    color: theme.colors.mutedForeground,
  },
  pressed: { opacity: 0.82 },
}));

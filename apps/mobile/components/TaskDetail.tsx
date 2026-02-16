import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, fonts, spacing, radius } from "@/lib/theme";
import type { Task } from "./TaskCard";

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: "rgba(234, 179, 8, 0.1)", text: colors.light.warning, label: "Todo" },
  "in-progress": { bg: "rgba(194, 112, 58, 0.1)", text: colors.light.primary, label: "In Progress" },
  completed: { bg: "rgba(34, 197, 94, 0.1)", text: colors.light.success, label: "Done" },
};

export function TaskDetail({ task, onClose }: TaskDetailProps) {
  const statusInfo = STATUS_COLORS[task.status] ?? STATUS_COLORS.pending;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Task Detail</Text>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
          >
            <Ionicons name="close" size={18} color={colors.light.mutedForeground} />
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={[styles.statusBadge, { backgroundColor: statusInfo.bg }]}>
            <Text style={[styles.statusText, { color: statusInfo.text }]}>
              {statusInfo.label}
            </Text>
          </View>

          <Text style={styles.taskTitle}>{task.input}</Text>

          <View style={styles.detailsList}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Type</Text>
              <Text style={styles.detailValue}>{task.type}</Text>
            </View>
            <View style={styles.separator} />
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>ID</Text>
              <Text style={styles.detailValue}>{task.id}</Text>
            </View>
            {task.priority !== undefined && (
              <>
                <View style={styles.separator} />
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Priority</Text>
                  <Text style={styles.detailValue}>{task.priority}</Text>
                </View>
              </>
            )}
            {task.createdAt && (
              <>
                <View style={styles.separator} />
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Created</Text>
                  <Text style={styles.detailValue}>{task.createdAt}</Text>
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.light.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  headerTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 18,
    color: colors.light.foreground,
  },
  closeButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.light.muted,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  closeButtonPressed: {
    opacity: 0.7,
  },
  closeText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.light.mutedForeground,
  },
  scrollContent: {
    padding: spacing.xl,
  },
  statusBadge: {
    alignSelf: "flex-start",
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    marginBottom: spacing.lg,
  },
  statusText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
  },
  taskTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 20,
    color: colors.light.foreground,
    marginBottom: spacing.xl,
    lineHeight: 28,
  },
  detailsList: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    overflow: "hidden",
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  detailLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.mutedForeground,
  },
  detailValue: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.light.foreground,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.light.border,
    marginHorizontal: spacing.lg,
  },
});

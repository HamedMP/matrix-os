import { useState, useCallback } from "react";
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator, StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { colors, fonts, spacing, radius } from "@/lib/theme";
import type { Task } from "./TaskCard";

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
  onStatusChange?: (taskId: string, status: string) => Promise<void>;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: "rgba(234, 179, 8, 0.1)", text: colors.light.warning, label: "Todo" },
  "in-progress": { bg: "rgba(194, 112, 58, 0.1)", text: colors.light.primary, label: "In Progress" },
  completed: { bg: "rgba(34, 197, 94, 0.1)", text: colors.light.success, label: "Done" },
};

export function TaskDetail({ task, onClose, onStatusChange }: TaskDetailProps) {
  const statusInfo = STATUS_COLORS[task.status] ?? STATUS_COLORS.pending;
  const [updating, setUpdating] = useState(false);
  const isCompleted = task.status === "completed";

  const handleToggleStatus = useCallback(async () => {
    if (!onStatusChange || updating) return;
    setUpdating(true);
    try {
      const newStatus = isCompleted ? "pending" : "completed";
      await onStatusChange(task.id, newStatus);
      if (process.env.EXPO_OS === "ios") {
        if (!isCompleted) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
      }
      onClose();
    } catch {
      // silently handle
    } finally {
      setUpdating(false);
    }
  }, [onStatusChange, updating, isCompleted, task.id, onClose]);

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.dragHandle} />
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

        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scrollContent}>
          <View style={[styles.statusBadge, { backgroundColor: statusInfo.bg }]}>
            <Text style={[styles.statusText, { color: statusInfo.text }]}>
              {statusInfo.label}
            </Text>
          </View>

          <Text selectable style={styles.taskTitle}>{task.input}</Text>

          <View style={styles.detailsList}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Type</Text>
              <Text style={styles.detailValue}>{task.type}</Text>
            </View>
            <View style={styles.separator} />
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>ID</Text>
              <Text selectable style={styles.detailValue}>{task.id}</Text>
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
                  <Text selectable style={styles.detailValue}>{task.createdAt}</Text>
                </View>
              </>
            )}
          </View>
        </ScrollView>

        {onStatusChange && (
          <View style={styles.actionBar}>
            <Pressable
              onPress={handleToggleStatus}
              disabled={updating}
              style={({ pressed }) => [
                styles.actionButton,
                isCompleted ? styles.actionReopen : styles.actionComplete,
                pressed && !updating && styles.actionPressed,
              ]}
            >
              {updating ? (
                <ActivityIndicator size="small" color={colors.light.primaryForeground} />
              ) : (
                <>
                  <Ionicons
                    name={isCompleted ? "refresh-outline" : "checkmark-circle-outline"}
                    size={18}
                    color={isCompleted ? colors.light.foreground : colors.light.primaryForeground}
                  />
                  <Text
                    style={[
                      styles.actionText,
                      isCompleted ? styles.actionTextReopen : styles.actionTextComplete,
                    ]}
                  >
                    {isCompleted ? "Reopen Task" : "Mark Complete"}
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        )}
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
    borderCurve: "continuous" as const,
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
    borderCurve: "continuous" as const,
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
  dragHandle: {
    width: 36,
    height: 5,
    borderRadius: 3,
    borderCurve: "continuous" as const,
    backgroundColor: colors.light.border,
    alignSelf: "center",
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  actionBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.light.border,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    paddingBottom: spacing["2xl"],
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderRadius: radius.lg,
    borderCurve: "continuous" as const,
    paddingVertical: spacing.md,
  },
  actionComplete: {
    backgroundColor: colors.light.primary,
  },
  actionReopen: {
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
  },
  actionPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  actionText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
  },
  actionTextComplete: {
    color: colors.light.primaryForeground,
  },
  actionTextReopen: {
    color: colors.light.foreground,
  },
});

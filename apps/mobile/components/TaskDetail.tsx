import { useState, useCallback } from "react";
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/lib/theme";
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
  const { theme } = useUnistyles();
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
            <Ionicons name="close" size={18} color={theme.colors.mutedForeground} />
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
                <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
              ) : (
                <>
                  <Ionicons
                    name={isCompleted ? "refresh-outline" : "checkmark-circle-outline"}
                    size={18}
                    color={isCompleted ? theme.colors.foreground : theme.colors.primaryForeground}
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

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.lg,
  },
  headerTitle: {
    fontFamily: theme.fonts.sansBold,
    fontSize: 18,
    color: theme.colors.foreground,
  },
  closeButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: theme.radius.sm,
    borderCurve: "continuous" as const,
    backgroundColor: theme.colors.muted,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 6,
  },
  closeButtonPressed: {
    opacity: 0.7,
  },
  closeText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 13,
    color: theme.colors.mutedForeground,
  },
  scrollContent: {
    padding: theme.spacing.xl,
  },
  statusBadge: {
    alignSelf: "flex-start",
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 4,
    marginBottom: theme.spacing.lg,
  },
  statusText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
  },
  taskTitle: {
    fontFamily: theme.fonts.sansBold,
    fontSize: 20,
    color: theme.colors.foreground,
    marginBottom: theme.spacing.xl,
    lineHeight: 28,
  },
  detailsList: {
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    overflow: "hidden",
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  detailLabel: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.mutedForeground,
  },
  detailValue: {
    fontFamily: theme.fonts.mono,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
    marginHorizontal: theme.spacing.lg,
  },
  dragHandle: {
    width: 36,
    height: 5,
    borderRadius: 3,
    borderCurve: "continuous" as const,
    backgroundColor: theme.colors.border,
    alignSelf: "center",
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  actionBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing.xl,
    paddingVertical: theme.spacing.lg,
    paddingBottom: theme.spacing["2xl"],
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    paddingVertical: theme.spacing.md,
  },
  actionComplete: {
    backgroundColor: theme.colors.primary,
  },
  actionReopen: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  actionPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  actionText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
  },
  actionTextComplete: {
    color: theme.colors.primaryForeground,
  },
  actionTextReopen: {
    color: theme.colors.foreground,
  },
}));

import { View, Text, Pressable, StyleSheet } from "react-native";
import { colors, fonts, spacing, radius } from "@/lib/theme";

export interface Task {
  id: string;
  type: string;
  status: string;
  input: string;
  priority?: number;
  createdAt?: string;
}

interface TaskCardProps {
  task: Task;
  onPress: () => void;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: "rgba(234, 179, 8, 0.1)", text: colors.light.warning, label: "Todo" },
  "in-progress": { bg: "rgba(194, 112, 58, 0.1)", text: colors.light.primary, label: "In Progress" },
  completed: { bg: "rgba(34, 197, 94, 0.1)", text: colors.light.success, label: "Done" },
};

export function TaskCard({ task, onPress }: TaskCardProps) {
  const statusInfo = STATUS_COLORS[task.status] ?? STATUS_COLORS.pending;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        pressed && styles.cardPressed,
      ]}
    >
      <View style={styles.topRow}>
        <Text style={styles.input} numberOfLines={2}>
          {task.input}
        </Text>
        <View style={[styles.statusBadge, { backgroundColor: statusInfo.bg }]}>
          <Text style={[styles.statusText, { color: statusInfo.text }]}>
            {statusInfo.label}
          </Text>
        </View>
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.type}>{task.type}</Text>
        {task.priority !== undefined && task.priority > 0 && (
          <View style={styles.priorityBadge}>
            <Text style={styles.priorityText}>P{task.priority}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  cardPressed: {
    opacity: 0.7,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  input: {
    flex: 1,
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.foreground,
  },
  statusBadge: {
    marginLeft: spacing.sm,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  statusText: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  type: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.light.mutedForeground,
  },
  priorityBadge: {
    borderRadius: radius.full,
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  priorityText: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: colors.light.destructive,
  },
});

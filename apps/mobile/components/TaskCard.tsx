import { View, Text, Pressable } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, { FadeInUp } from "react-native-reanimated";
import { colors } from "@/lib/theme";

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
    <Animated.View entering={FadeInUp.duration(250)}>
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
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.04)",
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
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.foreground,
  },
  statusBadge: {
    marginLeft: theme.spacing.sm,
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
  },
  statusText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 11,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  type: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.mutedForeground,
  },
  priorityBadge: {
    borderRadius: theme.radius.full,
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
  },
  priorityText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 11,
    color: theme.colors.destructive,
  },
}));

import { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  RefreshControl,
  TextInput,
  Alert,
  StyleSheet,
  type ListRenderItemInfo,
} from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import Animated, { ZoomIn } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useGateway } from "../_layout";
import { TaskCard, type Task } from "@/components/TaskCard";
import { TaskDetail } from "@/components/TaskDetail";
import { colors, fonts, spacing, radius } from "@/lib/theme";

type FilterStatus = "all" | "pending" | "in-progress" | "completed";

const FILTERS: { label: string; value: FilterStatus }[] = [
  { label: "All", value: "all" },
  { label: "Todo", value: "pending" },
  { label: "In Progress", value: "in-progress" },
  { label: "Done", value: "completed" },
];

function parseCronNextRun(schedule: string): string | null {
  if (!schedule) return null;
  const now = new Date();

  const intervalMatch = schedule.match(/^every\s+(\d+)\s*(m|min|minutes?|h|hours?|s|seconds?)$/i);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith("s")) ms = value * 1000;
    else if (unit.startsWith("m")) ms = value * 60 * 1000;
    else if (unit.startsWith("h")) ms = value * 60 * 60 * 1000;
    return formatRelativeTime(ms);
  }

  const cronParts = schedule.trim().split(/\s+/);
  if (cronParts.length === 5) {
    const [minute, hour] = cronParts;
    if (minute !== "*" && hour !== "*") {
      const targetMinute = parseInt(minute, 10);
      const targetHour = parseInt(hour, 10);
      if (!isNaN(targetMinute) && !isNaN(targetHour)) {
        const next = new Date(now);
        next.setHours(targetHour, targetMinute, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);
        const diffMs = next.getTime() - now.getTime();
        return formatRelativeTime(diffMs);
      }
    }
  }

  return null;
}

function formatRelativeTime(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "soon";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  if (hours < 48) return "tomorrow";
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

interface SwipeableTaskCardProps {
  task: Task;
  onPress: () => void;
  onComplete: () => void;
  onDelete: () => void;
}

function SwipeableTaskCard({ task, onPress, onComplete, onDelete }: SwipeableTaskCardProps) {
  const swipeableRef = useRef<Swipeable>(null);

  const renderLeftActions = () => (
    <View style={swipeStyles.completeAction}>
      <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
      <Text style={swipeStyles.actionText}>
        {task.status === "completed" ? "Reopen" : "Complete"}
      </Text>
    </View>
  );

  const renderRightActions = () => (
    <View style={swipeStyles.deleteAction}>
      <Ionicons name="trash-outline" size={20} color="#fff" />
      <Text style={swipeStyles.actionText}>Delete</Text>
    </View>
  );

  return (
    <Swipeable
      ref={swipeableRef}
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
      onSwipeableOpen={(direction) => {
        if (direction === "left") {
          if (process.env.EXPO_OS === "ios") {
            Haptics.notificationAsync(
              task.status === "completed"
                ? Haptics.NotificationFeedbackType.Warning
                : Haptics.NotificationFeedbackType.Success,
            );
          }
          onComplete();
        }
        if (direction === "right") {
          if (process.env.EXPO_OS === "ios") {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          }
          onDelete();
        }
        swipeableRef.current?.close();
      }}
    >
      <TaskCard task={task} onPress={onPress} />
    </Swipeable>
  );
}

export default function MissionControlScreen() {
  const { client, connectionState } = useGateway();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cronJobs, setCronJobs] = useState<unknown[]>([]);
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTaskInput, setNewTaskInput] = useState("");

  const fetchData = useCallback(async () => {
    if (!client || connectionState !== "connected") return;
    try {
      const [tasksData, cronData] = await Promise.all([
        client.getTasks(),
        client.getCron(),
      ]);
      setTasks(tasksData as Task[]);
      setCronJobs(cronData);
    } catch {
      // silently handle fetch errors
    }
  }, [client, connectionState]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = useCallback(async () => {
    if (process.env.EXPO_OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleAddTask = useCallback(async () => {
    if (!client || !newTaskInput.trim()) return;
    try {
      await client.createTask(newTaskInput.trim());
      setNewTaskInput("");
      setShowAddForm(false);
      await fetchData();
    } catch {
      Alert.alert("Error", "Failed to create task");
    }
  }, [client, newTaskInput, fetchData]);

  const handleCompleteTask = useCallback(async (task: Task) => {
    if (!client) return;
    try {
      const newStatus = task.status === "completed" ? "pending" : "completed";
      await client.updateTask(task.id, { status: newStatus });
      await fetchData();
    } catch {
      Alert.alert("Error", "Failed to update task");
    }
  }, [client, fetchData]);

  const handleDeleteTask = useCallback(async (task: Task) => {
    if (!client) return;
    Alert.alert(
      "Delete Task",
      `Delete "${task.input}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await client.deleteTask(task.id);
              setTasks((prev) => prev.filter((t) => t.id !== task.id));
            } catch {
              Alert.alert("Error", "Failed to delete task");
            }
          },
        },
      ],
    );
  }, [client]);

  const counts = {
    all: tasks.length,
    pending: tasks.filter((t) => t.status === "pending").length,
    "in-progress": tasks.filter((t) => t.status === "in-progress").length,
    completed: tasks.filter((t) => t.status === "completed").length,
  };

  const filteredTasks = filter === "all"
    ? tasks
    : tasks.filter((t) => t.status === filter);

  const renderTask = useCallback(
    ({ item }: ListRenderItemInfo<Task>) => (
      <SwipeableTaskCard
        task={item}
        onPress={() => setSelectedTask(item)}
        onComplete={() => handleCompleteTask(item)}
        onDelete={() => handleDeleteTask(item)}
      />
    ),
    [handleCompleteTask, handleDeleteTask],
  );

  return (
    <View style={styles.container}>
      {/* Filter chips with count badges */}
      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const isActive = filter === f.value;
          const count = counts[f.value];
          return (
            <Pressable
              key={f.value}
              onPress={() => setFilter(f.value)}
              style={[
                styles.filterChip,
                isActive ? styles.filterChipActive : styles.filterChipInactive,
              ]}
            >
              <Text
                style={[
                  styles.filterChipText,
                  isActive ? styles.filterChipTextActive : styles.filterChipTextInactive,
                ]}
              >
                {f.label} ({count})
              </Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={filteredTasks}
        renderItem={renderTask}
        keyExtractor={(item) => item.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.light.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIcon}>
              <Ionicons name="clipboard-outline" size={36} color={colors.light.primary} />
            </View>
            <Text style={styles.emptyLabel}>Tasks</Text>
            <Text style={styles.emptySubtitle}>No tasks yet</Text>
            <Text style={styles.emptyDescription}>
              Tap + to add a task, or ask your AI to create one in chat.
            </Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.cronSection}>
            <Text style={styles.cronSectionLabel}>Scheduled</Text>
            {cronJobs.length > 0 ? (
              cronJobs.map((job: any, i: number) => {
                const isActive = job.enabled !== false;
                const nextRun = parseCronNextRun(job.schedule ?? job.cron ?? "");
                return (
                  <View key={job.id ?? i} style={styles.cronCard}>
                    <View style={styles.cronIconContainer}>
                      <View
                        style={[
                          styles.cronStatusDot,
                          isActive ? styles.cronStatusActive : styles.cronStatusPaused,
                        ]}
                      />
                      <Ionicons name="time-outline" size={16} color={colors.light.primary} />
                    </View>
                    <View style={styles.cronTextContainer}>
                      <Text style={styles.cronName}>
                        {job.name ?? job.message ?? "Cron job"}
                      </Text>
                      <View style={styles.cronMetaRow}>
                        <Text style={styles.cronSchedule}>
                          {job.schedule ?? job.cron ?? ""}
                        </Text>
                        {nextRun && (
                          <Text style={styles.cronNextRun}>{nextRun}</Text>
                        )}
                      </View>
                    </View>
                    <Text style={[styles.cronBadge, isActive ? styles.cronBadgeActive : styles.cronBadgePaused]}>
                      {isActive ? "Active" : "Paused"}
                    </Text>
                  </View>
                );
              })
            ) : (
              <View style={styles.cronEmptyContainer}>
                <Ionicons name="calendar-outline" size={24} color={colors.light.mutedForeground} />
                <Text style={styles.cronEmptyText}>No scheduled jobs</Text>
                <Text style={styles.cronEmptySubtext}>
                  Ask your AI to set up recurring tasks or reminders.
                </Text>
              </View>
            )}
          </View>
        }
      />

      {/* Add task FAB / form */}
      {showAddForm ? (
        <View style={styles.addForm}>
          <TextInput
            style={styles.addFormInput}
            value={newTaskInput}
            onChangeText={setNewTaskInput}
            placeholder="What needs to be done?"
            placeholderTextColor={colors.light.mutedForeground}
            autoFocus
          />
          <View style={styles.addFormButtons}>
            <Pressable
              onPress={() => setShowAddForm(false)}
              style={({ pressed }) => [styles.addFormCancel, pressed && styles.buttonPressed]}
            >
              <Text style={styles.addFormCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleAddTask}
              disabled={!newTaskInput.trim()}
              style={({ pressed }) => [
                styles.addFormSubmit,
                newTaskInput.trim() ? styles.addFormSubmitActive : styles.addFormSubmitDisabled,
                pressed && newTaskInput.trim() && styles.buttonPressed,
              ]}
            >
              <Text
                style={[
                  styles.addFormSubmitText,
                  !newTaskInput.trim() && styles.addFormSubmitTextDisabled,
                ]}
              >
                Add Task
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Animated.View entering={ZoomIn.springify()}>
          <Pressable
            onPress={() => setShowAddForm(true)}
            style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          >
            <Ionicons name="add" size={28} color={colors.light.primaryForeground} />
          </Pressable>
        </Animated.View>
      )}

      {/* Task detail bottom sheet */}
      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onStatusChange={async (taskId, status) => {
            if (!client) return;
            await client.updateTask(taskId, { status });
            await fetchData();
          }}
        />
      )}
    </View>
  );
}

const swipeStyles = StyleSheet.create({
  completeAction: {
    backgroundColor: colors.light.success,
    justifyContent: "center",
    alignItems: "center",
    width: 90,
    borderRadius: radius.lg,
    borderCurve: "continuous" as const,
    flexDirection: "column",
    gap: 4,
  },
  deleteAction: {
    backgroundColor: colors.light.destructive,
    justifyContent: "center",
    alignItems: "center",
    width: 90,
    borderRadius: radius.lg,
    borderCurve: "continuous" as const,
    flexDirection: "column",
    gap: 4,
  },
  actionText: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: "#fff",
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light.background,
  },
  filterRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  filterChip: {
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
  },
  filterChipActive: {
    backgroundColor: colors.light.primary,
  },
  filterChipInactive: {
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
  },
  filterChipText: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
  },
  filterChipTextActive: {
    color: colors.light.primaryForeground,
  },
  filterChipTextInactive: {
    color: colors.light.foreground,
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 100,
    gap: spacing.sm,
  },
  emptyContainer: {
    alignItems: "center",
    paddingVertical: 60,
    paddingHorizontal: spacing.xl,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 18,
    borderCurve: "continuous" as const,
    backgroundColor: colors.light.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  emptyLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.light.primary,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: spacing.sm,
  },
  emptySubtitle: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 16,
    color: colors.light.foreground,
    marginBottom: spacing.sm,
  },
  emptyDescription: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.mutedForeground,
    textAlign: "center",
    lineHeight: 20,
  },
  cronSection: {
    marginTop: spacing.xl,
  },
  cronSectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.light.primary,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: spacing.sm,
  },
  cronCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  cronIconContainer: {
    position: "relative",
  },
  cronStatusDot: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    zIndex: 1,
    borderWidth: 1.5,
    borderColor: colors.light.card,
  },
  cronStatusActive: {
    backgroundColor: colors.light.success,
  },
  cronStatusPaused: {
    backgroundColor: colors.light.mutedForeground,
  },
  cronTextContainer: {
    flex: 1,
  },
  cronName: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.foreground,
  },
  cronMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 2,
  },
  cronSchedule: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.light.mutedForeground,
  },
  cronNextRun: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: colors.light.primary,
  },
  cronBadge: {
    fontFamily: fonts.sansMedium,
    fontSize: 10,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    overflow: "hidden",
  },
  cronBadgeActive: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    color: colors.light.success,
  },
  cronBadgePaused: {
    backgroundColor: "rgba(120, 113, 108, 0.1)",
    color: colors.light.mutedForeground,
  },
  cronEmptyContainer: {
    alignItems: "center",
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: colors.light.border,
    borderStyle: "dashed",
    backgroundColor: colors.light.card,
  },
  cronEmptyText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.mutedForeground,
    marginTop: spacing.sm,
  },
  cronEmptySubtext: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.light.mutedForeground,
    textAlign: "center",
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  addForm: {
    position: "absolute",
    bottom: 24,
    left: spacing.lg,
    right: spacing.lg,
    borderRadius: radius.xl,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    padding: spacing.lg,
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
  },
  addFormInput: {
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.light.foreground,
    borderRadius: radius.md,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.background,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    marginBottom: spacing.md,
  },
  addFormButtons: {
    flexDirection: "row",
    gap: spacing.md,
  },
  addFormCancel: {
    flex: 1,
    alignItems: "center",
    borderRadius: radius.md,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: colors.light.border,
    paddingVertical: 10,
  },
  addFormCancelText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.mutedForeground,
  },
  addFormSubmit: {
    flex: 1,
    alignItems: "center",
    borderRadius: radius.md,
    borderCurve: "continuous" as const,
    paddingVertical: 10,
  },
  addFormSubmitActive: {
    backgroundColor: colors.light.primary,
  },
  addFormSubmitDisabled: {
    backgroundColor: colors.light.muted,
  },
  addFormSubmitText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
    color: colors.light.primaryForeground,
  },
  addFormSubmitTextDisabled: {
    color: colors.light.mutedForeground,
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  fab: {
    position: "absolute",
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 8px rgba(194, 112, 58, 0.3)",
  },
  fabPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.95 }],
  },
});

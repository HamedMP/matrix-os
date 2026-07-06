import { useEffect, useReducer, useCallback, useRef, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  RefreshControl,
  TextInput,
  Alert,
  type ListRenderItemInfo,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Swipeable } from "react-native-gesture-handler";
import Animated, { ZoomIn } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useGateway } from "../_layout";
import { TaskCard, type Task } from "@/components/TaskCard";
import { TaskDetail } from "@/components/TaskDetail";

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

function renderRightActions() {
  return (
    <View style={swipeStyles.deleteAction}>
      <Ionicons name="trash-outline" size={20} color="#fff" />
      <Text style={swipeStyles.actionText}>Delete</Text>
    </View>
  );
}

interface MissionState {
  tasks: Task[];
  cronJobs: unknown[];
  filter: FilterStatus;
  refreshing: boolean;
  selectedTask: Task | null;
  showAddForm: boolean;
  newTaskInput: string;
}

type MissionAction =
  | { type: "dataLoaded"; tasks: Task[]; cronJobs: unknown[] }
  | { type: "tasksSet"; tasks: Task[] }
  | { type: "setFilter"; filter: FilterStatus }
  | { type: "setRefreshing"; value: boolean }
  | { type: "selectTask"; task: Task | null }
  | { type: "setShowAddForm"; value: boolean }
  | { type: "setNewTaskInput"; value: string }
  | { type: "taskAdded" };

const INITIAL_MISSION_STATE: MissionState = {
  tasks: [],
  cronJobs: [],
  filter: "all",
  refreshing: false,
  selectedTask: null,
  showAddForm: false,
  newTaskInput: "",
};

function missionReducer(state: MissionState, action: MissionAction): MissionState {
  switch (action.type) {
    case "dataLoaded":
      return { ...state, tasks: action.tasks, cronJobs: action.cronJobs };
    case "tasksSet":
      return { ...state, tasks: action.tasks };
    case "setFilter":
      return { ...state, filter: action.filter };
    case "setRefreshing":
      return { ...state, refreshing: action.value };
    case "selectTask":
      return { ...state, selectedTask: action.task };
    case "setShowAddForm":
      return { ...state, showAddForm: action.value };
    case "setNewTaskInput":
      return { ...state, newTaskInput: action.value };
    case "taskAdded":
      return { ...state, newTaskInput: "", showAddForm: false };
    default:
      return state;
  }
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
  const { theme } = useUnistyles();
  const { client } = useGateway();
  const [state, dispatch] = useReducer(missionReducer, INITIAL_MISSION_STATE);
  const { tasks, cronJobs, filter, refreshing, selectedTask, showAddForm, newTaskInput } = state;

  // Keep a live ref of tasks so deferred Alert callbacks read the latest list
  // (the reducer has no functional-update form for the async delete callback).
  const tasksRef = useRef(tasks);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const fetchData = useCallback(async () => {
    if (!client) return;
    try {
      const [tasksData, cronData] = await Promise.all([
        client.getTasks(),
        client.getCron(),
      ]);
      dispatch({ type: "dataLoaded", tasks: tasksData as Task[], cronJobs: cronData });
    } catch {
      // silently handle fetch errors
    }
  }, [client]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = useCallback(async () => {
    if (process.env.EXPO_OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    dispatch({ type: "setRefreshing", value: true });
    await fetchData();
    dispatch({ type: "setRefreshing", value: false });
  }, [fetchData]);

  const handleAddTask = useCallback(async () => {
    if (!client || !newTaskInput.trim()) return;
    try {
      await client.createTask(newTaskInput.trim());
      dispatch({ type: "taskAdded" });
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
              dispatch({ type: "tasksSet", tasks: tasksRef.current.filter((t) => t.id !== task.id) });
            } catch {
              Alert.alert("Error", "Failed to delete task");
            }
          },
        },
      ],
    );
  }, [client]);

  const counts = useMemo(() => ({
    all: tasks.length,
    pending: tasks.filter((t) => t.status === "pending").length,
    "in-progress": tasks.filter((t) => t.status === "in-progress").length,
    completed: tasks.filter((t) => t.status === "completed").length,
  }), [tasks]);

  const filteredTasks = filter === "all"
    ? tasks
    : tasks.filter((t) => t.status === filter);

  const renderTask = useCallback(
    ({ item }: ListRenderItemInfo<Task>) => (
      <SwipeableTaskCard
        task={item}
        onPress={() => dispatch({ type: "selectTask", task: item })}
        onComplete={() => handleCompleteTask(item)}
        onDelete={() => handleDeleteTask(item)}
      />
    ),
    [handleCompleteTask, handleDeleteTask],
  );

  const refreshControl = useMemo(
    () => (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={handleRefresh}
        tintColor={theme.colors.primary}
      />
    ),
    [refreshing, handleRefresh, theme.colors.primary],
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
              onPress={() => dispatch({ type: "setFilter", filter: f.value })}
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
        refreshControl={refreshControl}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIcon}>
              <Ionicons name="clipboard-outline" size={36} color={theme.colors.primary} />
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
                      <Ionicons name="time-outline" size={16} color={theme.colors.primary} />
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
                <Ionicons name="calendar-outline" size={24} color={theme.colors.mutedForeground} />
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
            onChangeText={(value) => dispatch({ type: "setNewTaskInput", value })}
            placeholder="What needs to be done?"
            placeholderTextColor={theme.colors.mutedForeground}
            autoFocus
          />
          <View style={styles.addFormButtons}>
            <Pressable
              onPress={() => dispatch({ type: "setShowAddForm", value: false })}
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
            onPress={() => dispatch({ type: "setShowAddForm", value: true })}
            style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          >
            <Ionicons name="add" size={28} color={theme.colors.primaryForeground} />
          </Pressable>
        </Animated.View>
      )}

      {/* Task detail bottom sheet */}
      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={() => dispatch({ type: "selectTask", task: null })}
          onStatusChange={async (taskId, status) => {
            if (!client) return;
            try {
              await client.updateTask(taskId, { status });
              await fetchData();
            } catch {
              Alert.alert("Error", "Failed to update task status");
            }
          }}
        />
      )}
    </View>
  );
}

const swipeStyles = StyleSheet.create((theme) => ({
  completeAction: {
    backgroundColor: theme.colors.success,
    justifyContent: "center",
    alignItems: "center",
    width: 90,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    flexDirection: "column",
    gap: 4,
  },
  deleteAction: {
    backgroundColor: theme.colors.destructive,
    justifyContent: "center",
    alignItems: "center",
    width: 90,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    flexDirection: "column",
    gap: 4,
  },
  actionText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 11,
    color: "#fff",
  },
}));

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  filterRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  filterChip: {
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 6,
  },
  filterChipActive: {
    backgroundColor: theme.colors.primary,
  },
  filterChipInactive: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  filterChipText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
  },
  filterChipTextActive: {
    color: theme.colors.primaryForeground,
  },
  filterChipTextInactive: {
    color: theme.colors.foreground,
  },
  listContent: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: 100,
    gap: theme.spacing.sm,
  },
  emptyContainer: {
    alignItems: "center",
    paddingVertical: 60,
    paddingHorizontal: theme.spacing.xl,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 18,
    borderCurve: "continuous" as const,
    backgroundColor: theme.colors.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  emptyLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.primary,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: theme.spacing.sm,
  },
  emptySubtitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 16,
    color: theme.colors.foreground,
    marginBottom: theme.spacing.sm,
  },
  emptyDescription: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.mutedForeground,
    textAlign: "center",
    lineHeight: 20,
  },
  cronSection: {
    marginTop: theme.spacing.xl,
  },
  cronSectionLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.primary,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: theme.spacing.sm,
  },
  cronCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
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
    borderColor: theme.colors.card,
  },
  cronStatusActive: {
    backgroundColor: theme.colors.success,
  },
  cronStatusPaused: {
    backgroundColor: theme.colors.mutedForeground,
  },
  cronTextContainer: {
    flex: 1,
  },
  cronName: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.foreground,
  },
  cronMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    marginTop: 2,
  },
  cronSchedule: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  cronNextRun: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 11,
    color: theme.colors.primary,
  },
  cronBadge: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 10,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
    overflow: "hidden",
  },
  cronBadgeActive: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    color: theme.colors.success,
  },
  cronBadgePaused: {
    backgroundColor: "rgba(120, 113, 108, 0.1)",
    color: theme.colors.mutedForeground,
  },
  cronEmptyContainer: {
    alignItems: "center",
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderStyle: "dashed",
    backgroundColor: theme.colors.card,
  },
  cronEmptyText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.mutedForeground,
    marginTop: theme.spacing.sm,
  },
  cronEmptySubtext: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
    textAlign: "center",
    marginTop: theme.spacing.xs,
    lineHeight: 18,
  },
  addForm: {
    position: "absolute",
    bottom: 24,
    left: theme.spacing.lg,
    right: theme.spacing.lg,
    borderRadius: theme.radius.xl,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.lg,
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
  },
  addFormInput: {
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    color: theme.colors.foreground,
    borderRadius: theme.radius.md,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
    marginBottom: theme.spacing.md,
  },
  addFormButtons: {
    flexDirection: "row",
    gap: theme.spacing.md,
  },
  addFormCancel: {
    flex: 1,
    alignItems: "center",
    borderRadius: theme.radius.md,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 10,
  },
  addFormCancelText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.mutedForeground,
  },
  addFormSubmit: {
    flex: 1,
    alignItems: "center",
    borderRadius: theme.radius.md,
    borderCurve: "continuous" as const,
    paddingVertical: 10,
  },
  addFormSubmitActive: {
    backgroundColor: theme.colors.primary,
  },
  addFormSubmitDisabled: {
    backgroundColor: theme.colors.muted,
  },
  addFormSubmitText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 14,
    color: theme.colors.primaryForeground,
  },
  addFormSubmitTextDisabled: {
    color: theme.colors.mutedForeground,
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
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 8px rgba(194, 112, 58, 0.3)",
  },
  fabPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.95 }],
  },
}));

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

  const filteredTasks = filter === "all"
    ? tasks
    : tasks.filter((t) => t.status === filter);

  const renderTask = useCallback(
    ({ item }: ListRenderItemInfo<Task>) => (
      <TaskCard task={item} onPress={() => setSelectedTask(item)} />
    ),
    [],
  );

  return (
    <View style={styles.container}>
      {/* Filter chips */}
      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const isActive = filter === f.value;
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
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={filteredTasks}
        renderItem={renderTask}
        keyExtractor={(item) => item.id}
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
          cronJobs.length > 0 ? (
            <View style={styles.cronSection}>
              <Text style={styles.cronSectionLabel}>Scheduled</Text>
              {cronJobs.map((job: any, i: number) => (
                <View key={job.id ?? i} style={styles.cronCard}>
                  <Ionicons name="time-outline" size={16} color={colors.light.primary} />
                  <View style={styles.cronTextContainer}>
                    <Text style={styles.cronName}>
                      {job.name ?? job.message ?? "Cron job"}
                    </Text>
                    <Text style={styles.cronSchedule}>
                      {job.schedule ?? job.cron ?? ""}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null
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
        <Pressable
          onPress={() => setShowAddForm(true)}
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        >
          <Ionicons name="add" size={28} color={colors.light.primaryForeground} />
        </Pressable>
      )}

      {/* Task detail bottom sheet */}
      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </View>
  );
}

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
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  cronTextContainer: {
    flex: 1,
  },
  cronName: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.foreground,
  },
  cronSchedule: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.light.mutedForeground,
    marginTop: 2,
  },
  addForm: {
    position: "absolute",
    bottom: 24,
    left: spacing.lg,
    right: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    padding: spacing.lg,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  addFormInput: {
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.light.foreground,
    borderRadius: radius.md,
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
    shadowColor: colors.light.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  fabPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.95 }],
  },
});

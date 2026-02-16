import { useEffect, useState, useCallback, useRef } from "react";
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
    <View className="flex-1 bg-background">
      {/* Filter chips */}
      <View className="flex-row gap-2 px-4 py-3">
        {FILTERS.map((f) => (
          <Pressable
            key={f.value}
            onPress={() => setFilter(f.value)}
            className={`rounded-full px-4 py-1.5 ${
              filter === f.value
                ? "bg-primary"
                : "border border-border bg-card"
            }`}
          >
            <Text
              className={`text-xs font-medium ${
                filter === f.value
                  ? "text-primary-foreground"
                  : "text-foreground"
              }`}
            >
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={filteredTasks}
        renderItem={renderTask}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 100, gap: 8 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#c2703a"
          />
        }
        ListEmptyComponent={
          <View className="items-center py-20">
            <Text className="font-mono text-xs uppercase tracking-widest text-primary">
              Tasks
            </Text>
            <Text className="mt-2 text-sm text-muted-foreground">
              No tasks yet
            </Text>
          </View>
        }
        ListFooterComponent={
          cronJobs.length > 0 ? (
            <View className="mt-6">
              <Text className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
                Scheduled
              </Text>
              {cronJobs.map((job: any, i: number) => (
                <View
                  key={job.id ?? i}
                  className="mb-2 rounded-xl border border-border bg-card px-4 py-3"
                >
                  <Text className="text-sm font-medium text-foreground">
                    {job.name ?? job.message ?? "Cron job"}
                  </Text>
                  <Text className="mt-1 font-mono text-xs text-muted-foreground">
                    {job.schedule ?? job.cron ?? ""}
                  </Text>
                </View>
              ))}
            </View>
          ) : null
        }
      />

      {/* Add task FAB */}
      {showAddForm ? (
        <View className="absolute bottom-6 left-4 right-4 rounded-xl border border-border bg-card p-4 shadow-lg">
          <TextInput
            className="mb-3 rounded-lg border border-border bg-background px-3 py-2.5 text-base text-foreground"
            style={{ fontFamily: "Inter_400Regular" }}
            value={newTaskInput}
            onChangeText={setNewTaskInput}
            placeholder="What needs to be done?"
            placeholderTextColor="#78716c"
            autoFocus
          />
          <View className="flex-row gap-3">
            <Pressable
              onPress={() => setShowAddForm(false)}
              className="flex-1 items-center rounded-lg border border-border py-2.5"
            >
              <Text className="text-sm text-muted-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleAddTask}
              disabled={!newTaskInput.trim()}
              className={`flex-1 items-center rounded-lg py-2.5 ${
                newTaskInput.trim() ? "bg-primary" : "bg-muted"
              }`}
            >
              <Text
                className={`text-sm font-medium ${
                  newTaskInput.trim() ? "text-primary-foreground" : "text-muted-foreground"
                }`}
              >
                Add Task
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={() => setShowAddForm(true)}
          className="absolute bottom-6 right-6 size-14 items-center justify-center rounded-full bg-primary shadow-lg"
        >
          <Text className="text-2xl font-bold text-primary-foreground">+</Text>
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

import { View, Text, Pressable, Modal, ScrollView } from "react-native";
import type { Task } from "./TaskCard";

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: "bg-warning/10", text: "text-warning", label: "Todo" },
  "in-progress": { bg: "bg-primary/10", text: "text-primary", label: "In Progress" },
  completed: { bg: "bg-success/10", text: "text-success", label: "Done" },
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
      <View className="flex-1 bg-background">
        <View className="flex-row items-center justify-between border-b border-border px-4 py-4">
          <Text className="text-lg font-bold text-foreground" style={{ fontFamily: "Inter_700Bold" }}>
            Task Detail
          </Text>
          <Pressable
            onPress={onClose}
            className="rounded-lg bg-muted px-3 py-1.5"
          >
            <Text className="text-sm text-muted-foreground">Close</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 24 }}>
          <View className={`mb-4 self-start rounded-full px-3 py-1 ${statusInfo.bg}`}>
            <Text className={`text-sm font-medium ${statusInfo.text}`}>
              {statusInfo.label}
            </Text>
          </View>

          <Text className="mb-4 text-xl font-bold text-foreground" style={{ fontFamily: "Inter_700Bold" }}>
            {task.input}
          </Text>

          <View className="gap-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground">Type</Text>
              <Text className="font-mono text-sm text-foreground">{task.type}</Text>
            </View>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground">ID</Text>
              <Text className="font-mono text-sm text-foreground">{task.id}</Text>
            </View>
            {task.priority !== undefined && (
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-muted-foreground">Priority</Text>
                <Text className="font-mono text-sm text-foreground">{task.priority}</Text>
              </View>
            )}
            {task.createdAt && (
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-muted-foreground">Created</Text>
                <Text className="text-sm text-foreground">{task.createdAt}</Text>
              </View>
            )}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

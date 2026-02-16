import { View, Text, Pressable } from "react-native";

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
  pending: { bg: "bg-warning/10", text: "text-warning", label: "Todo" },
  "in-progress": { bg: "bg-primary/10", text: "text-primary", label: "In Progress" },
  completed: { bg: "bg-success/10", text: "text-success", label: "Done" },
};

export function TaskCard({ task, onPress }: TaskCardProps) {
  const statusInfo = STATUS_COLORS[task.status] ?? STATUS_COLORS.pending;

  return (
    <Pressable
      onPress={onPress}
      className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm active:opacity-70"
    >
      <View className="flex-row items-start justify-between">
        <Text
          className="flex-1 text-sm font-medium text-foreground"
          numberOfLines={2}
          style={{ fontFamily: "Inter_500Medium" }}
        >
          {task.input}
        </Text>
        <View className={`ml-2 rounded-full px-2 py-0.5 ${statusInfo.bg}`}>
          <Text className={`text-xs font-medium ${statusInfo.text}`}>
            {statusInfo.label}
          </Text>
        </View>
      </View>
      <View className="mt-2 flex-row items-center gap-2">
        <Text className="font-mono text-xs text-muted-foreground">
          {task.type}
        </Text>
        {task.priority !== undefined && task.priority > 0 && (
          <View className="rounded-full bg-destructive/10 px-2 py-0.5">
            <Text className="text-xs text-destructive">P{task.priority}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

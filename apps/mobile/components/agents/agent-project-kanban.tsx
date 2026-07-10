import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useUnistyles } from "react-native-unistyles";
import type {
  AgentThreadSummary,
  ProjectAgentWorkspace,
  TaskAgentSummary,
} from "@matrix-os/contracts";
import type { AgentWorkspaceViewMode } from "@/lib/agent-workspace-state";
import { countLabel, taskThreads } from "./agent-project-utils";
import { agentProjectKanbanStyles as styles } from "./agent-project-kanban-styles";

type CanonicalTaskStatus = TaskAgentSummary["status"];

const CANONICAL_TASK_COLUMNS: readonly {
  status: CanonicalTaskStatus;
  label: string;
}[] = [
  { status: "todo", label: "To do" },
  { status: "running", label: "Running" },
  { status: "waiting", label: "Waiting" },
  { status: "blocked", label: "Blocked" },
  { status: "complete", label: "Complete" },
];

export function AgentProjectViewModeControl({
  viewMode,
  onChange,
}: {
  viewMode: AgentWorkspaceViewMode;
  onChange: (viewMode: AgentWorkspaceViewMode) => void;
}) {
  return (
    <View accessibilityLabel="Project workspace view" style={styles.segmentedControl}>
      <ViewModeButton
        label="Conversation"
        selected={viewMode === "conversation"}
        onPress={() => onChange("conversation")}
      />
      <ViewModeButton
        label="Kanban"
        selected={viewMode === "kanban"}
        onPress={() => onChange("kanban")}
      />
    </View>
  );
}

export function AgentProjectKanban({
  workspace,
  tablet,
  onOpenThread,
  onNewConversation,
}: {
  workspace: ProjectAgentWorkspace;
  tablet: boolean;
  onOpenThread: (thread: AgentThreadSummary) => void;
  onNewConversation: (taskId: string) => void;
}) {
  return (
    <View
      testID={tablet ? "kanban-tablet-board" : "kanban-phone-board"}
      style={[styles.board, tablet ? styles.tabletBoard : null]}
    >
      {CANONICAL_TASK_COLUMNS.map((column) => {
        const tasks = tasksForStatus(workspace, column.status);
        return (
          <View
            key={column.status}
            style={[styles.column, tablet ? styles.tabletColumn : null]}
          >
            <View
              accessible
              accessibilityLabel={`${column.label} column, ${countLabel(tasks.length, "task")}`}
              style={styles.columnHeader}
            >
              <Text selectable style={styles.columnTitle}>{column.label}</Text>
              <Text selectable style={styles.columnCount}>{tasks.length}</Text>
            </View>
            {tasks.length === 0 ? (
              <Text selectable style={styles.emptyText}>No tasks.</Text>
            ) : null}
            {tasks.map((task) => (
              <KanbanTaskCard
                key={task.id}
                task={task}
                threads={taskThreads(workspace, task.id)}
                onNewConversation={() => onNewConversation(task.id)}
                onOpenThread={onOpenThread}
              />
            ))}
          </View>
        );
      })}
    </View>
  );
}

export function tasksForStatus(
  workspace: ProjectAgentWorkspace,
  status: CanonicalTaskStatus,
): TaskAgentSummary[] {
  return workspace.tasks.items
    .filter((task) => task.status === status)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function ViewModeButton({
  label,
  selected,
  onPress,
}: {
  label: "Conversation" | "Kanban";
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show ${label}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.segment, selected ? styles.segmentSelected : null]}
    >
      <Text style={[styles.segmentText, selected ? styles.segmentTextSelected : null]}>{label}</Text>
    </Pressable>
  );
}

function KanbanTaskCard({
  task,
  threads,
  onOpenThread,
  onNewConversation,
}: {
  task: TaskAgentSummary;
  threads: AgentThreadSummary[];
  onOpenThread: (thread: AgentThreadSummary) => void;
  onNewConversation: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.taskCard}>
      <View style={styles.taskHeader}>
        <View
          accessible
          accessibilityLabel={taskAccessibilityLabel(task)}
          style={styles.taskHeadingCopy}
        >
          <Text selectable style={styles.taskTitle}>{task.title}</Text>
          <Text selectable style={styles.taskMeta}>{task.priority} priority</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New Kanban conversation for ${task.title}`}
          onPress={onNewConversation}
          style={styles.addButton}
        >
          <Ionicons name="add" size={16} color={theme.colors.forest} />
        </Pressable>
      </View>
      <View style={styles.aggregateRow}>
        <Aggregate label="chats" value={task.threadCount} />
        <Aggregate label="active" value={task.activeThreadCount} />
        <Aggregate label="attention" value={task.attentionCount} attention={task.attentionCount > 0} />
      </View>
      {threads.length === 0 ? (
        <Text selectable style={styles.emptyText}>No conversations.</Text>
      ) : (
        <View style={styles.threadList}>
          {threads.map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              accessibilityLabel={`Open Kanban conversation ${thread.title}`}
              onPress={() => onOpenThread(thread)}
              style={styles.threadRow}
            >
              <View style={styles.threadCopy}>
                <Text selectable numberOfLines={1} style={styles.threadTitle}>{thread.title}</Text>
                <Text selectable style={styles.threadMeta}>{thread.providerId} · {thread.status.replace(/_/g, " ")}</Text>
              </View>
              {thread.attention && thread.attention !== "none" ? <View style={styles.attentionDot} /> : null}
              <Ionicons name="chevron-forward" size={15} color={theme.colors.mutedForeground} />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function Aggregate({
  label,
  value,
  attention = false,
}: {
  label: string;
  value: number;
  attention?: boolean;
}) {
  return (
    <View style={[styles.aggregate, attention ? styles.aggregateAttention : null]}>
      <Text selectable style={styles.aggregateValue}>{value}</Text>
      <Text selectable style={styles.aggregateLabel}>{label}</Text>
    </View>
  );
}

function taskAccessibilityLabel(task: TaskAgentSummary): string {
  return [
    task.title,
    task.status,
    countLabel(task.threadCount, "conversation"),
    `${task.activeThreadCount} active`,
    `${task.attentionCount} needs attention`,
  ].join(", ");
}

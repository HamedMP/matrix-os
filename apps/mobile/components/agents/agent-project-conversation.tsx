import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useUnistyles } from "react-native-unistyles";
import type { AgentThreadSummary, ProjectAgentWorkspace } from "@matrix-os/contracts";
import { countLabel, taskThreads } from "./agent-project-utils";
import { agentProjectWorkspaceStyles as styles } from "./agent-project-workspace-styles";

export function AgentProjectConversation({
  workspace,
  onOpenThread,
  onNewConversation,
}: {
  workspace: ProjectAgentWorkspace;
  onOpenThread: (thread: AgentThreadSummary) => void;
  onNewConversation: (taskId: string) => void;
}) {
  const { theme } = useUnistyles();
  return (
    <>
      <ConversationSection title="Project chats" count={workspace.projectThreads.items.length}>
        {workspace.projectThreads.items.length === 0 ? (
          <Text selectable style={styles.emptyText}>No project-level conversations yet.</Text>
        ) : null}
        {workspace.projectThreads.items.map((thread) => (
          <ConversationRow key={thread.id} thread={thread} onPress={() => onOpenThread(thread)} />
        ))}
      </ConversationSection>

      <View style={styles.taskList}>
        <Text selectable style={styles.sectionHeading}>Tasks</Text>
        {workspace.tasks.items.length === 0 ? (
          <Text selectable style={styles.emptyText}>No tasks are available in this project.</Text>
        ) : null}
        {workspace.tasks.items.map((task) => {
          const threads = taskThreads(workspace, task.id);
          return (
            <View
              key={task.id}
              accessible
              accessibilityLabel={`${task.title}, ${countLabel(task.threadCount, "conversation")}`}
              style={styles.taskCard}
            >
              <View style={styles.taskHeader}>
                <View style={styles.taskHeaderText}>
                  <Text selectable style={styles.rowTitle}>{task.title}</Text>
                  <Text selectable style={styles.rowSubtitle}>
                    {countLabel(task.threadCount, "conversation")} · {task.status.replace(/_/g, " ")}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`New conversation for ${task.title}`}
                  onPress={() => onNewConversation(task.id)}
                  style={styles.secondaryButton}
                >
                  <Ionicons name="add" size={16} color={theme.colors.forest} />
                </Pressable>
              </View>
              {threads.length === 0 ? (
                <Text selectable style={styles.emptyText}>No conversations for this task.</Text>
              ) : null}
              {threads.map((thread) => (
                <ConversationRow key={thread.id} thread={thread} onPress={() => onOpenThread(thread)} />
              ))}
            </View>
          );
        })}
      </View>
    </>
  );
}

function ConversationSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionTitleRow}>
        <Text selectable style={styles.sectionHeading}>{title}</Text>
        <Text selectable style={styles.countText}>{count}</Text>
      </View>
      {children}
    </View>
  );
}

function ConversationRow({
  thread,
  onPress,
}: {
  thread: AgentThreadSummary;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open conversation ${thread.title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.threadRow, pressed ? styles.pressed : null]}
    >
      <View style={styles.threadIcon}>
        <Ionicons name="chatbubble-ellipses-outline" size={17} color={theme.colors.moss} />
      </View>
      <View style={styles.threadText}>
        <Text selectable numberOfLines={1} style={styles.rowTitle}>{thread.title}</Text>
        <Text selectable style={styles.rowSubtitle}>
          {thread.providerId} · {thread.status.replace(/_/g, " ")}
        </Text>
      </View>
      {thread.attention && thread.attention !== "none" ? <View style={styles.attentionDot} /> : null}
      <Ionicons name="chevron-forward" size={17} color={theme.colors.mutedForeground} />
    </Pressable>
  );
}

import { FlatList, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { ListRowSkeletonStack } from "@/components/shell/Controls";
import { TabScreen } from "@/components/shell/TabScreen";
import {
  AddIcon,
  AgentMascot,
  AgentsTabIcon,
  Button,
  EmptyState,
  ItemRow,
  StatusDot,
} from "@/components/ui";

import type { AgentListRow } from "./agent-rows";

export interface AgentsListScreenProps {
  /** "unavailable": the list could not be read, or agents are switched off on this computer. */
  state: "loading" | "unavailable" | "ready";
  rows: readonly AgentListRow[];
  refreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onNewAgent: () => void;
  onOpenAgent: (agentId: string) => void;
}

/** The Agents tab's first screen: every agent with what it is doing. */
export function AgentsListScreen({
  state,
  rows,
  refreshing,
  onRefresh,
  onRetry,
  onNewAgent,
  onOpenAgent,
}: AgentsListScreenProps) {
  return (
    <TabScreen testID="agents-screen">
      <View testID="agents-header" style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>Agents</Text>
        <Button testID="agents-new" variant="secondary" icon={AddIcon} label="New agent" onPress={onNewAgent} />
      </View>
      {state === "loading" ? (
        <View testID="agents-loading" style={styles.inset}>
          <ListRowSkeletonStack testID="agents-skeleton-row" />
        </View>
      ) : state === "unavailable" ? (
        <View testID="agents-unavailable" style={[styles.inset, styles.notice]}>
          <Text accessibilityRole="alert" style={styles.noticeText}>Agents are not available right now.</Text>
          <Button variant="outline" label="Try again" onPress={onRetry} />
        </View>
      ) : (
        <FlatList
          testID="agents-list"
          data={rows}
          keyExtractor={(row) => row.id}
          refreshing={refreshing}
          onRefresh={onRefresh}
          contentContainerStyle={styles.list}
          renderItem={({ item: row }) => (
            <ItemRow
              testID={`agent-row-${row.id}`}
              accessibilityLabel={[row.name, row.subtitle, row.time].filter(Boolean).join(", ")}
              leading={<AgentMascot id={row.id} name={row.name} category={row.category} />}
              title={row.name}
              titleAccessory={row.tone ? <StatusDot testID={`agent-dot-${row.id}`} tone={row.tone} /> : undefined}
              subtitle={row.subtitle}
              meta={row.time || undefined}
              onPress={() => onOpenAgent(row.id)}
            />
          )}
          ListEmptyComponent={(
            <View testID="agents-empty" style={styles.empty}>
              <EmptyState icon={AgentsTabIcon} message="No agents yet" />
              <Button fullWidth icon={AddIcon} label="New agent" onPress={onNewAgent} />
            </View>
          )}
        />
      )}
    </TabScreen>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme.v2.space[8],
    marginHorizontal: theme.v2.space[20],
    marginBottom: theme.v2.space[20],
  },
  title: {
    ...theme.v2.text.title,
    color: theme.v2.colors.textDefault,
  },
  inset: {
    paddingHorizontal: theme.v2.space[20],
  },
  notice: {
    alignItems: "center",
    gap: theme.v2.space[16],
    paddingTop: theme.v2.space[24],
  },
  noticeText: {
    ...theme.v2.text.label,
    color: theme.v2.colors.textSubtle,
    textAlign: "center",
  },
  // Grows to the screen's height so the empty state has room to centre itself.
  list: {
    flexGrow: 1,
    gap: theme.v2.space[4],
    paddingHorizontal: theme.v2.space[20],
    paddingBottom: theme.v2.space[20],
  },
  empty: {
    flex: 1,
    gap: theme.v2.space[16],
  },
}));

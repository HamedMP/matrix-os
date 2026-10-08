import { FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { ListRowSkeletonStack, SearchField } from "@/components/shell/Controls";
import { TabScreen } from "@/components/shell/TabScreen";
import {
  AgentMascot,
  BackIcon,
  Button,
  ChevronRightIcon,
  EmptyState,
  Icon,
  ItemRow,
  SearchIcon,
  TopBar,
  TopBarButton,
} from "@/components/ui";

import type { AgentTemplate } from "./agent-templates";

const BACK_ICON_SIZE = 22;
const CHEVRON_SIZE = 18;

export interface NewAgentScreenProps {
  state: "loading" | "error" | "ready";
  /** The templates to list: those matching `query`. */
  templates: readonly AgentTemplate[];
  query: string;
  onChangeQuery: (query: string) => void;
  onRetry: () => void;
  onBack: () => void;
  onSelectTemplate: (template: AgentTemplate) => void;
}

/** Where a new agent starts: the templates it can be made from. */
export function NewAgentScreen({
  state,
  templates,
  query,
  onChangeQuery,
  onRetry,
  onBack,
  onSelectTemplate,
}: NewAgentScreenProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();

  return (
    <TabScreen testID="new-agent-screen">
      <TopBar
        testID="new-agent-top-bar"
        align="start"
        title="New agent"
        leading={(
          <TopBarButton icon={BackIcon} iconSize={BACK_ICON_SIZE} accessibilityLabel="Back" onPress={onBack} />
        )}
      />
      <View testID="new-agent-body" style={styles.body}>
        <Text accessibilityRole="header" style={styles.heading}>What should your agent do?</Text>
        <SearchField placeholder="Search templates" value={query} onChangeText={onChangeQuery} />
        {state === "loading" ? (
          <ListRowSkeletonStack testID="template-skeleton-row" />
        ) : state === "error" ? (
          <View testID="template-error" style={styles.notice}>
            <Text accessibilityRole="alert" style={styles.noticeText}>Templates could not be loaded.</Text>
            <Button variant="text" label="Try again" onPress={onRetry} />
          </View>
        ) : (
          <FlatList
            testID="template-list"
            data={templates}
            keyExtractor={(template) => `${template.recipeId}@${template.version}`}
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + theme.v2.space[20] }]}
            renderItem={({ item: template }) => (
              <ItemRow
                testID={`template-row-${template.recipeId}`}
                accessibilityLabel={[template.name, template.description].filter(Boolean).join(", ")}
                density="comfortable"
                leading={<AgentMascot id={template.recipeId} name={template.name} category={template.category} />}
                title={template.name}
                subtitle={template.description}
                trailing={<Icon icon={ChevronRightIcon} size={CHEVRON_SIZE} color={theme.v2.colors.textSubtle} />}
                onPress={() => onSelectTemplate(template)}
              />
            )}
            ListEmptyComponent={(
              <EmptyState
                icon={SearchIcon}
                message={query.trim() ? "No templates match that search." : "No templates yet."}
              />
            )}
          />
        )}
      </View>
    </TabScreen>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    flex: 1,
    gap: theme.v2.space[16],
    paddingTop: theme.v2.space[8],
    paddingHorizontal: theme.v2.space[20],
  },
  heading: {
    ...theme.v2.text.heading,
    color: theme.v2.colors.textDefault,
  },
  notice: {
    alignItems: "center",
    gap: theme.v2.space[4],
  },
  noticeText: {
    ...theme.v2.text.label,
    color: theme.v2.colors.textSubtle,
    textAlign: "center",
  },
  // Grows to the screen's height so the empty state has room to centre itself.
  list: {
    flexGrow: 1,
    gap: theme.v2.space[2],
  },
}));

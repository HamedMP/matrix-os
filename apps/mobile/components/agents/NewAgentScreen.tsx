import { useRef } from "react";
import { FlatList, ScrollView, Text, View, type ListRenderItemInfo } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { ListRowSkeletonStack, SearchField } from "@/components/shell/Controls";
import { TabScreen } from "@/components/shell/TabScreen";
import {
  AgentMascot,
  BackIcon,
  Button,
  ChevronRightIcon,
  Chip,
  EmptyState,
  Icon,
  ItemRow,
  SearchIcon,
  TopBar,
  TopBarButton,
} from "@/components/ui";

import type { AgentInspiration } from "./agent-inspirations.generated";
import type { AgentTemplate } from "./agent-templates";

const BACK_ICON_SIZE = 22;
const CHEVRON_SIZE = 18;

export interface NewAgentScreenProps {
  state: "loading" | "error" | "ready";
  /** The computer's templates to list: those matching `query` and `category`. */
  templates: readonly AgentTemplate[];
  /** The inspirations to list after them, matching the same. */
  inspirations: readonly AgentInspiration[];
  query: string;
  onChangeQuery: (query: string) => void;
  /** The categories the gallery can be narrowed to. */
  categories: readonly string[];
  category: string;
  onChangeCategory: (category: string) => void;
  onRetry: () => void;
  onBack: () => void;
  onSelectTemplate: (template: AgentTemplate) => void;
  onSelectInspiration: (inspiration: AgentInspiration) => void;
}

type GalleryItem =
  | { kind: "template"; template: AgentTemplate }
  | { kind: "inspiration"; inspiration: AgentInspiration };

/** Where a new agent starts: the gallery of templates it can be made from. */
export function NewAgentScreen({
  state,
  templates,
  inspirations,
  query,
  onChangeQuery,
  categories,
  category,
  onChangeCategory,
  onRetry,
  onBack,
  onSelectTemplate,
  onSelectInspiration,
}: NewAgentScreenProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<GalleryItem>>(null);
  // A new search or category lists other templates, which are read from the top.
  const showFromTop = () => list.current?.scrollToOffset({ offset: 0, animated: false });
  const items: GalleryItem[] = [
    ...templates.map((template) => ({ kind: "template" as const, template })),
    ...inspirations.map((inspiration) => ({ kind: "inspiration" as const, inspiration })),
  ];
  const select = (item: GalleryItem) => {
    if (item.kind === "template") onSelectTemplate(item.template);
    else onSelectInspiration(item.inspiration);
  };
  const renderRow = ({ item }: ListRenderItemInfo<GalleryItem>) => <GalleryRow item={item} onSelect={select} />;

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
        <SearchField
          placeholder="Search templates"
          value={query}
          // Left on, the keyboard rewrites names such as "tinkabot" when a row is pressed.
          autoCorrect={false}
          onChangeText={(text) => {
            showFromTop();
            onChangeQuery(text);
          }}
        />
        <ScrollView
          testID="template-categories"
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.categories}
          contentContainerStyle={styles.categoryChips}
        >
          {categories.map((name) => (
            <Chip
              key={name}
              testID={`template-category-${name}`}
              label={name}
              selected={name === category}
              onPress={() => {
                showFromTop();
                onChangeCategory(name);
              }}
            />
          ))}
        </ScrollView>
        {state === "loading" ? (
          <ListRowSkeletonStack testID="template-skeleton-row" />
        ) : (
          <FlatList
            ref={list}
            testID="template-list"
            data={items}
            keyExtractor={(item) => (
              item.kind === "template"
                ? `${item.template.recipeId}@${item.template.version}`
                : `inspiration:${item.inspiration.id}`
            )}
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            style={styles.listFrame}
            contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + theme.v2.space[20] }]}
            renderItem={renderRow}
            // The computer's templates could not be read; the inspirations ship with the app.
            ListHeaderComponent={state === "error" ? (
              <View testID="template-error" style={styles.notice}>
                <Text accessibilityRole="alert" style={styles.noticeText}>Some templates could not be loaded.</Text>
                <Button variant="text" label="Try again" onPress={onRetry} />
              </View>
            ) : null}
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

interface GalleryRowProps {
  item: GalleryItem;
  onSelect: (item: GalleryItem) => void;
}

/** A template of the computer or an inspiration, drawn alike. */
function GalleryRow({ item, onSelect }: GalleryRowProps) {
  const { theme } = useUnistyles();
  const { name, description } = item.kind === "template" ? item.template : item.inspiration;
  const id = item.kind === "template" ? item.template.recipeId : item.inspiration.id;
  // An inspiration's first category decides its mascot's colour.
  const category = item.kind === "template" ? item.template.category : item.inspiration.categories[0];

  return (
    <ItemRow
      testID={`template-row-${id}`}
      accessibilityLabel={[name, description].filter(Boolean).join(", ")}
      density="comfortable"
      leading={<AgentMascot id={id} name={name} category={category} />}
      title={name}
      subtitle={description}
      trailing={<Icon icon={ChevronRightIcon} size={CHEVRON_SIZE} color={theme.v2.colors.textSubtle} />}
      onPress={() => onSelect(item)}
    />
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
  // The row runs to both edges of the screen, so chips scroll under them, and
  // keeps its height when the list below is longer than the screen. A chip is
  // drawn shorter than its tap target: the row gives it the rest above and
  // below, and takes the same back from the space around the row.
  categories: {
    flexGrow: 0,
    flexShrink: 0,
    marginHorizontal: -theme.v2.space[20],
    marginVertical: -(theme.v2.size.tapTarget - theme.v2.size.chip) / 2,
  },
  categoryChips: {
    gap: theme.v2.space[8],
    paddingHorizontal: theme.v2.space[20],
    paddingVertical: (theme.v2.size.tapTarget - theme.v2.size.chip) / 2,
  },
  notice: {
    alignItems: "center",
    gap: theme.v2.space[4],
    paddingBottom: theme.v2.space[8],
  },
  noticeText: {
    ...theme.v2.text.label,
    color: theme.v2.colors.textSubtle,
    textAlign: "center",
  },
  // The list runs to both edges of the screen, so its scroll indicator sits at
  // the edge instead of over the rows' chevrons.
  listFrame: {
    marginHorizontal: -theme.v2.space[20],
  },
  // Grows to the screen's height so the empty state has room to centre itself.
  list: {
    flexGrow: 1,
    gap: theme.v2.space[2],
    paddingHorizontal: theme.v2.space[20],
  },
}));

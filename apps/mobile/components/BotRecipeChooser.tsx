import { useRef, useState, type RefObject } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { BotRecipeRef, BotRecipeSummary } from "@matrix-os/contracts";
import { canonicalChatRequestId } from "@/lib/requests";

export interface BotCreationAttempt { scope: string; key: string; requestId: string }

export function BotRecipeChooser({ recipes, onCreate, onOpenChat, attemptRef, attemptScope = "" }: {
  recipes: BotRecipeSummary[];
  onCreate: (recipe: BotRecipeRef, requestId: string) => Promise<string>;
  onOpenChat: (chatId: string) => void;
  attemptRef?: RefObject<BotCreationAttempt | null>;
  attemptScope?: string;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const localAttempt = useRef<BotCreationAttempt | null>(null);
  const attempt = attemptRef ?? localAttempt;
  const normalized = query.trim().toLocaleLowerCase();
  const visible = recipes.filter((recipe) => !normalized || [recipe.name, recipe.description, recipe.output]
    .some((value) => value.toLocaleLowerCase().includes(normalized)));

  const create = async (recipe: BotRecipeSummary) => {
    if (pending) return;
    const key = `${recipe.recipeId}@${recipe.version}`;
    if (attempt.current?.key !== key || attempt.current.scope !== attemptScope) {
      attempt.current = { scope: attemptScope, key, requestId: canonicalChatRequestId() };
    }
    setPending(key);
    setError("");
    try {
      const chatId = await onCreate({ recipeId: recipe.recipeId, version: recipe.version }, attempt.current.requestId);
      onOpenChat(chatId);
      attempt.current = null;
    } catch (failure: unknown) {
      console.warn("[mobile-bots] Bot creation failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError("Bot could not be created. Try again.");
    } finally {
      setPending(null);
    }
  };

  return <View style={styles.panel}>
    <Text style={styles.title}>Bot recipes</Text>
    <TextInputSearch value={query} onChangeText={setQuery} />
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
    <FlatList style={styles.scroller} contentContainerStyle={styles.list} nestedScrollEnabled
      data={visible} keyExtractor={(recipe) => `${recipe.recipeId}@${recipe.version}`}
      renderItem={({ item: recipe }) => <View style={styles.card}>
        <Text style={styles.heading}>{recipe.name}</Text>
        <Text style={styles.text}>{recipe.description}</Text>
        <Text style={styles.muted}>Creates: {recipe.output}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Use ${recipe.name}`} disabled={!!pending}
          style={styles.button} onPress={() => void create(recipe)}>
          <Text style={styles.text}>{pending === `${recipe.recipeId}@${recipe.version}` ? "Creating…" : "Build in Chat"}</Text>
        </Pressable>
      </View>}
      ListEmptyComponent={<Text style={styles.muted}>No matching recipes.</Text>} />
  </View>;
}

function TextInputSearch({ value, onChangeText }: { value: string; onChangeText: (value: string) => void }) {
  return <TextInput accessibilityLabel="Search bot recipes" value={value} onChangeText={onChangeText}
    placeholder="Search bot recipes" placeholderTextColor={styles.muted.color} style={[styles.button, styles.text]} />;
}

const styles = StyleSheet.create((theme) => ({
  panel: { padding: 12, borderBottomWidth: 1, borderColor: theme.colors.border, gap: 8 },
  title: { color: theme.colors.foreground, fontWeight: "600", fontSize: 16 },
  heading: { color: theme.colors.foreground, fontWeight: "600" },
  text: { color: theme.colors.foreground },
  muted: { color: theme.colors.mutedForeground },
  scroller: { maxHeight: 320 },
  list: { gap: 10 },
  card: { padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, gap: 6 },
  button: { padding: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 },
}));

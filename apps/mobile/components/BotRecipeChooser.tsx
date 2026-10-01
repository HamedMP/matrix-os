import { useRef, useState, type RefObject } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { managedPiBotModelChoices, type CanonicalProviderCatalog, type CanonicalChatModelSelection, type BotRecipeRef, type BotRecipeSummary } from "@matrix-os/contracts";
import { canonicalChatRequestId } from "@/lib/requests";

export interface BotCreationAttempt { scope: string; key: string; requestId: string; selection?: CanonicalChatModelSelection | null }

export function BotRecipeChooser({ recipes, onCreate, onOpenChat, attemptRef, attemptScope = "", catalog }: {
  recipes: BotRecipeSummary[]; catalog?: CanonicalProviderCatalog | null;
  onCreate: (recipe: BotRecipeRef, requestId: string, selection?: CanonicalChatModelSelection) => Promise<string>;
  onOpenChat: (chatId: string) => void;
  attemptRef?: RefObject<BotCreationAttempt | null>;
  attemptScope?: string;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const localAttempt = useRef<BotCreationAttempt | null>(null);
  const attempt = attemptRef ?? localAttempt;
  const [selection, setSelection] = useState<CanonicalChatModelSelection | null>(() =>
    attempt.current?.scope === attemptScope ? attempt.current.selection ?? null : null);
  const choices = managedPiBotModelChoices(catalog);
  const modelAvailable = !selection || choices.some((choice) => choice.selection.instanceId === selection.instanceId && choice.selection.model === selection.model);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = recipes.filter((recipe) => !normalized || [recipe.name, recipe.description, recipe.output]
    .some((value) => value.toLocaleLowerCase().includes(normalized)));

  const create = async (recipe: BotRecipeSummary) => {
    if (pending || !modelAvailable) return;
    const key = `${recipe.recipeId}@${recipe.version}:${JSON.stringify(selection)}`;
    if (attempt.current?.key !== key || attempt.current.scope !== attemptScope) {
      attempt.current = { scope: attemptScope, key, requestId: canonicalChatRequestId(), selection };
    }
    const requestId = attempt.current.requestId;
    setPending(key);
    setError("");
    try {
      const ref = { recipeId: recipe.recipeId, version: recipe.version };
      const chatId = await (selection ? onCreate(ref, requestId, selection) : onCreate(ref, requestId));
      onOpenChat(chatId);
      if (attempt.current?.requestId === requestId) attempt.current = null;
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
    <Text style={styles.heading}>Bot model</Text>
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: !selection, disabled: !!pending }} disabled={!!pending}
      style={styles.button} onPress={() => setSelection(null)}><Text style={styles.text}>Automatic · managed by this computer</Text></Pressable>
    {choices.map((choice) => <Pressable key={choice.selection.model} accessibilityRole="radio"
      accessibilityState={{ checked: selection?.model === choice.selection.model, disabled: !!pending }} disabled={!!pending}
      style={styles.button} onPress={() => setSelection(choice.selection)}><Text style={styles.text}>{choice.label}</Text></Pressable>)}
    {!modelAvailable ? <Text style={styles.muted}>This saved Matrix AI model is unavailable. Choose another model or check Agents &amp; providers.</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
    <FlatList style={styles.scroller} contentContainerStyle={styles.list} nestedScrollEnabled
      data={visible} keyExtractor={(recipe) => `${recipe.recipeId}@${recipe.version}`}
      renderItem={({ item: recipe }) => <View style={styles.card}>
        <Text style={styles.heading}>{recipe.name}</Text>
        <Text style={styles.text}>{recipe.description}</Text>
        <Text style={styles.muted}>Creates: {recipe.output}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Use ${recipe.name}`} disabled={!!pending || !modelAvailable}
          style={styles.button} onPress={() => void create(recipe)}>
          <Text style={styles.text}>{pending?.startsWith(`${recipe.recipeId}@${recipe.version}:`) ? "Creating…" : "Build in Chat"}</Text>
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

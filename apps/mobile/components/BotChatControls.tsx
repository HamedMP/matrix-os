import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { blockedNativeBotModelRows } from "@/lib/bot-model-discovery";
import {
  managedPiBotModelChoices, MATRIX_BOT_SELECTION, botModelRoutingLabel, botInteractionCard, botTaskStatusCopy, groupBotAuthority,
  type CanonicalChatModelSelection, type CanonicalProviderCatalog, type BotAuthorityView, type BotInteraction, type BotMemoryMutationRequest,
  type BotTaskSummary, type ResolveBotInteractionRequest, type ResolveBotInteractionResponse,
} from "@matrix-os/contracts";

export interface BotChatSnapshot {
  agentId: string;
  name: string;
  selection?: CanonicalChatModelSelection;
  revision?: number;
  interactions: BotInteraction[];
  tasks: BotTaskSummary[];
  authority: BotAuthorityView;
}

interface BotChatControlsProps {
  snapshot: BotChatSnapshot;
  catalog?: CanonicalProviderCatalog | null;
  actionsAvailable?: boolean;
  onSelectionChange?: (selection: CanonicalChatModelSelection) => Promise<unknown>;
  onResolve: (interactionId: string, input: ResolveBotInteractionRequest) => Promise<ResolveBotInteractionResponse>;
  onRevoke: (grantId: string) => Promise<unknown>;
  onMemory: (itemId: string, action: "confirm" | "forget", input: BotMemoryMutationRequest) => Promise<unknown>;
  onRefresh: () => Promise<unknown> | void;
  onConnectUrl?: (url: string) => Promise<unknown> | void;
}

const encodedLength = (value: string) => new TextEncoder().encode(value).byteLength;

function BotQuestion({ interaction, onResolve, busy }: {
  interaction: BotInteraction;
  onResolve: (input: ResolveBotInteractionRequest) => Promise<void>;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  if (interaction.payload?.kind !== "question") return null;
  const questions = interaction.payload.questions;
  const answers = Object.fromEntries(questions.map((question) => {
    const choice = selected[question.questionId] ?? [];
    const custom = typed[question.questionId]?.trim();
    return [question.questionId, question.multiSelect
      ? [...choice, ...(custom ? [custom] : [])] : custom ? [custom] : choice.slice(0, 1)];
  })) as Record<string, string[]>;
  const complete = questions.every((question) => (answers[question.questionId]?.length ?? 0) > 0)
    && Object.values(answers).every((values) => values.every((value) => encodedLength(value) <= 700));
  return <View style={styles.group}>
    {questions.map((question) => <View key={question.questionId} style={styles.group}>
      <Text style={styles.text}>{question.question}</Text>
      {question.options?.map((option) => {
        const checked = selected[question.questionId]?.includes(option.label) ?? false;
        return <Pressable key={option.label} accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
          accessibilityLabel={option.label} accessibilityState={{ checked, disabled: busy }} disabled={busy}
          style={[styles.button, checked ? styles.selected : undefined]}
          onPress={() => {
            setSelected((current) => {
              const values = current[question.questionId] ?? [];
              const next = question.multiSelect
                ? checked ? values.filter((value) => value !== option.label)
                  : values.length < 10 ? [...values, option.label] : values
                : [option.label];
              return { ...current, [question.questionId]: next };
            });
            if (!question.multiSelect) setTyped((current) => ({ ...current, [question.questionId]: "" }));
          }}>
          <Text style={styles.text}>{option.label}</Text>
          <Text style={styles.muted}>{option.description}</Text>
        </Pressable>;
      })}
      {(!question.options || question.allowOther) ? <TextInput
        accessibilityLabel={`Answer ${question.header}`} value={typed[question.questionId] ?? ""}
        secureTextEntry={question.secret} maxLength={400} editable={!busy}
        placeholder={question.options ? "Other answer" : "Your answer"} placeholderTextColor={styles.muted.color}
        style={[styles.button, styles.text]} onChangeText={(value) => {
          setTyped((current) => ({ ...current, [question.questionId]: value }));
        }} /> : null}
    </View>)}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !complete }}
      disabled={busy || !complete} style={styles.button}
      onPress={() => void onResolve({
        kind: "question", baseRevision: interaction.revision, structuredAnswers: answers,
      })}><Text style={styles.text}>Answer</Text></Pressable>
  </View>;
}

function BotInteractionControl({ interaction, onResolve, onRefresh, onConnectUrl, actionsAvailable }: {
  interaction: BotInteraction;
  actionsAvailable: boolean;
  onResolve: BotChatControlsProps["onResolve"];
  onRefresh: BotChatControlsProps["onRefresh"];
  onConnectUrl?: BotChatControlsProps["onConnectUrl"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [settled, setSettled] = useState(false);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const card = botInteractionCard(interaction, new Date().toISOString());
  const actionable = card.state === "actionable" && !settled && actionsAvailable;
  const resolve = async (input: ResolveBotInteractionRequest) => {
    if (!actionable || busy) return;
    setBusy(true);
    setError("");
    let didResolve = false;
    try {
      const result = await onResolve(interaction.interactionId, input);
      didResolve = true;
      setSettled(true);
      setConnectUrl(result.connectUrl ?? null);
    } catch (failure: unknown) {
      console.warn("[mobile-bots] Resolution failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError("Could not save your response. Try again.");
    } finally {
      setBusy(false);
    }
    if (!didResolve) return;
    try {
      await onRefresh();
    } catch (failure: unknown) {
      console.warn("[mobile-bots] Status refresh failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError("Bot status could not be loaded. Try again.");
    }
  };
  const payload = interaction.payload;
  return <View style={styles.card}>
    <Text style={styles.heading}>{card.title}</Text>
    {!actionable ? <Text style={styles.muted}>{settled ? "Resolved" : !actionsAvailable && card.state === "actionable"
      ? "Status unavailable. Refresh to respond." : card.state}</Text> : null}
    {!actionsAvailable && card.state === "actionable" && payload?.kind === "question"
      ? payload.questions.map((question) => <Text key={question.questionId} style={styles.text}>{question.question}</Text>) : null}
    {actionable && payload?.kind === "question" ? <BotQuestion interaction={interaction} busy={busy} onResolve={resolve} /> : null}
    {actionable && payload?.kind === "account_choice" ? <>
      {payload.options.map((option) => <Pressable key={option.connectionId} accessibilityRole="button"
        disabled={busy} style={styles.button} onPress={() => void resolve({ kind: "account_choice",
          baseRevision: interaction.revision, connectionId: option.connectionId })}>
        <Text style={styles.text}>{option.label}</Text>
      </Pressable>)}
    </> : null}
    {actionable && payload?.kind === "connect_request" ? <>
      <Text style={styles.text}>{payload.benefit}</Text>
      <Text style={styles.muted}>Requested access: {payload.access.join(", ")}</Text>
      {(["start", "decline"] as const).map((action) => <Pressable key={action} accessibilityRole="button"
        disabled={busy} style={styles.button} onPress={() => void resolve({ kind: "connect_request",
          baseRevision: interaction.revision, action })}>
        <Text style={styles.text}>{action === "start" ? "Connect" : "Decline"}</Text>
      </Pressable>)}
    </> : null}
    {actionable && payload?.kind === "approval" ? <>
      <Text style={styles.text}>{payload.preview}</Text>
      {(["approve", "deny"] as const).map((decision) => <Pressable key={decision} accessibilityRole="button"
        disabled={busy} style={styles.button} onPress={() => void resolve({ kind: "approval",
          baseRevision: interaction.revision, decision })}>
        <Text style={styles.text}>{decision === "approve" ? "Approve" : "Deny"}</Text>
      </Pressable>)}
    </> : null}
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
    {connectUrl ? <Pressable accessibilityRole="link" style={styles.button} onPress={() => {
      setError("");
      void Promise.resolve(onConnectUrl?.(connectUrl)).catch((failure: unknown) => {
        console.warn("[mobile-bots] Connection page failed:", failure instanceof Error ? failure.name : "UnknownError");
        setError("Could not open the connection page. Try again.");
      });
    }}><Text style={styles.text}>Continue connecting</Text></Pressable> : null}
  </View>;
}

export function BotChatControls({ snapshot, catalog, onSelectionChange, actionsAvailable = true, onResolve, onRevoke, onMemory, onRefresh, onConnectUrl }: BotChatControlsProps) {
  const [showAuthority, setShowAuthority] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const change = async (key: string, action: () => Promise<unknown>) => {
    if (pending || !actionsAvailable) return;
    setPending(key);
    setError("");
    try {
      await action();
    } catch (failure: unknown) {
      console.warn("[mobile-bots] Authority change failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError(key === "model" ? "Bot model could not be saved. Try again." : "Could not change bot access. Try again.");
      setPending(null);
      return;
    }
    try {
      await onRefresh();
    } catch (failure: unknown) {
      console.warn("[mobile-bots] Status refresh failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError("Bot status could not be loaded. Try again.");
    } finally {
      setPending(null);
    }
  };
  const authority = snapshot.authority;
  return <View style={styles.panel}>
    <View style={styles.header}>
      <View style={styles.title}><Text style={styles.heading}>{snapshot.name}</Text><Text style={styles.muted}>Your bot&apos;s Chat</Text><Text style={styles.muted}>Model: {botModelRoutingLabel(snapshot.selection, catalog)}</Text></View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showAuthority }} style={styles.button}
        onPress={() => setShowAuthority((value) => !value)}><Text style={styles.text}>Access &amp; memory</Text></Pressable>
    </View>
    <ScrollView style={styles.scroller} contentContainerStyle={styles.group} nestedScrollEnabled>
      {onSelectionChange && snapshot.revision ? <View style={styles.group}>
        <Text style={styles.heading}>Bot model</Text>
        <Pressable accessibilityRole="button" disabled={!!pending || !actionsAvailable} style={styles.button}
          onPress={() => void change("model", () => onSelectionChange(MATRIX_BOT_SELECTION))}>
          <Text style={styles.text}>Automatic · managed by this computer</Text></Pressable>
        {managedPiBotModelChoices(catalog).map((choice) => <Pressable key={choice.selection.model} accessibilityRole="button"
          disabled={!!pending || !actionsAvailable} style={styles.button}
          onPress={() => void change("model", () => onSelectionChange(choice.selection))}>
          <Text style={styles.text}>{choice.label}</Text></Pressable>)}
        {blockedNativeBotModelRows(catalog).map(row => <Text key={`${row.instanceId}:${row.modelId}`}
          accessibilityRole="text" accessibilityState={{ disabled: true }} style={styles.muted}>{row.label}</Text>)}
      </View> : null}
      {snapshot.interactions.map((interaction) => <BotInteractionControl key={interaction.interactionId}
        interaction={interaction} actionsAvailable={actionsAvailable}
        onResolve={onResolve} onRefresh={onRefresh} onConnectUrl={onConnectUrl} />)}
      {snapshot.tasks.map((task) => <Text key={task.taskId} style={styles.muted}>{botTaskStatusCopy(task)}</Text>)}
      {showAuthority ? <View style={styles.card}>
        <Text style={styles.heading}>What this bot can access</Text>
        {groupBotAuthority(authority).map((group) => <View key={group.service} style={styles.group}>
          <Text style={styles.text}>{group.service.replaceAll("_", " ")} · {group.state.replaceAll("_", " ")}</Text>
          {group.grants.map((grant) => <View key={grant.grantId} style={styles.group}>
            <Text style={styles.text}>{grant.accountLabel} · {grant.effects.join(", ")}</Text>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!pending || !actionsAvailable }}
              disabled={!!pending || !actionsAvailable} style={styles.button}
              onPress={() => void change(grant.grantId, () => onRevoke(grant.grantId))}>
              <Text style={styles.text}>Revoke {grant.accountLabel}</Text></Pressable>
          </View>)}
        </View>)}
        <Text style={styles.heading}>Remembered</Text>
        {authority.memory.items.map((item) => <View key={item.itemId} style={styles.group}>
          <Text style={styles.text}>{item.content}</Text>
          <Text style={styles.muted}>From Chat · {item.source.at}</Text>
          {!item.confirmed ? <Pressable accessibilityRole="button" disabled={!!pending || !actionsAvailable} style={styles.button}
            onPress={() => void change(item.itemId, () => onMemory(item.itemId, "confirm", { baseRevision: item.revision }))}>
            <Text style={styles.text}>Confirm memory</Text></Pressable> : null}
          <Pressable accessibilityRole="button" disabled={!!pending || !actionsAvailable} style={styles.button}
            onPress={() => void change(item.itemId, () => onMemory(item.itemId, "forget", { baseRevision: item.revision }))}>
            <Text style={styles.text}>Forget memory</Text></Pressable>
        </View>)}
      </View> : null}
      {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  panel: { padding: 12, borderBottomWidth: 1, borderColor: theme.colors.border, gap: 8 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1 },
  scroller: { maxHeight: 280 },
  card: { padding: 12, gap: 8, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12 },
  group: { gap: 8 },
  heading: { color: theme.colors.foreground, fontWeight: "600" },
  text: { color: theme.colors.foreground },
  muted: { color: theme.colors.mutedForeground },
  button: { padding: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 },
  selected: { backgroundColor: theme.colors.muted },
}));

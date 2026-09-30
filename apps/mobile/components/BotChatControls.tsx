import { useState } from "react";
import { Keyboard, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BotSettingsSheet } from "./BotSettingsSheet";
import {
  botInteractionCard, botTaskStatusCopy,
  type BotAuthorityView, type BotInteraction, type BotMemoryMutationRequest,
  type BotTaskSummary, type ResolveBotInteractionRequest, type ResolveBotInteractionResponse,
} from "@matrix-os/contracts";

export interface BotChatSnapshot {
  agentId: string;
  name: string;
  interactions: BotInteraction[];
  tasks: BotTaskSummary[];
  authority: BotAuthorityView;
}

interface BotChatControlsProps {
  /** Owner, runtime, and Chat identity: bots with matching IDs may belong to different scopes. */
  scopeKey: string;
  snapshot: BotChatSnapshot;
  actionsAvailable?: boolean;
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

export function BotChatControls(props: BotChatControlsProps) {
  return <BotChatControlsForAgent key={JSON.stringify([props.scopeKey, props.snapshot.agentId])} {...props} />;
}

function BotChatControlsForAgent({ snapshot, actionsAvailable = true, onResolve, onRevoke, onMemory, onRefresh, onConnectUrl }: BotChatControlsProps) {
  const [showSettings, setShowSettings] = useState(false);
  return <View style={styles.panel}>
    <View style={styles.header}>
      <View style={styles.title}><Text style={styles.heading}>{snapshot.name}</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Bot settings"
        accessibilityState={{ expanded: showSettings }} style={styles.button}
        onPress={() => { Keyboard.dismiss(); setShowSettings(true); }}><Text style={styles.text}>Bot settings</Text></Pressable>
    </View>
    {snapshot.interactions.length || snapshot.tasks.length ? <ScrollView style={styles.scroller}
      contentContainerStyle={styles.group} nestedScrollEnabled>
      {snapshot.interactions.map((interaction) => <BotInteractionControl key={interaction.interactionId}
        interaction={interaction} actionsAvailable={actionsAvailable}
        onResolve={onResolve} onRefresh={onRefresh} onConnectUrl={onConnectUrl} />)}
      {snapshot.tasks.map((task) => <Text key={task.taskId} style={styles.muted}>{botTaskStatusCopy(task)}</Text>)}
    </ScrollView> : null}
    <BotSettingsSheet open={showSettings} name={snapshot.name} authority={snapshot.authority}
      actionsAvailable={actionsAvailable} onClose={() => setShowSettings(false)}
      onRevoke={onRevoke} onMemory={onMemory} onRefresh={onRefresh} />
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

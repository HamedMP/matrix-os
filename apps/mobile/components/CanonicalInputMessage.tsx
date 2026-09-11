import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAuth } from "@clerk/clerk-expo";
import {
  buildCanonicalChatInputAnswer,
  CanonicalChatInputSubmissionResponseSchema,
  CanonicalSubmitChatInputRequestSchema,
  type CanonicalChatInputView,
} from "@matrix-os/contracts";
import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

function own<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

function withValue<T>(values: Record<string, T>, key: string, value: T): Record<string, T> {
  return Object.fromEntries([...Object.entries(values), [key, value]]);
}

export function CanonicalInputMessage({ request, chatId, gatewayUrl, onSettled }: {
  request: CanonicalChatInputView;
  chatId: string;
  gatewayUrl: string;
  onSettled: () => Promise<unknown> | void;
}) {
  const { getToken } = useAuth();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, boolean>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [expired, setExpired] = useState(() => !!request.expiresAt && Date.parse(request.expiresAt) <= Date.now());
  useEffect(() => {
    if (!request.expiresAt) return;
    const remaining = Date.parse(request.expiresAt) - Date.now();
    if (remaining <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [request.expiresAt]);
  const actionable = request.pending && !request.resolved && !request.submitted && !submitted && !expired;
  const structuredAnswers = Object.fromEntries((request.questions ?? []).map(question => [question.questionId,
    [...(own(answers, question.questionId) ?? []), ...((!question.options?.length || own(other, question.questionId)) && own(custom, question.questionId)?.trim() ? [own(custom, question.questionId)!.trim()] : [])],
  ]));
  const answer = buildCanonicalChatInputAnswer(request, structuredAnswers);
  const complete = answer !== null && (request.questions ?? []).every(question => !own(other, question.questionId) || !!own(custom, question.questionId)?.trim());

  async function submit() {
    if (inFlight.current || !actionable || !complete) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // Preserve the native request identity even if the local answer is edited.
      const key = JSON.stringify([chatId, request.runId, request.requestId]);
      if (attempt.current?.key !== key) attempt.current = { key, id: canonicalChatRequestId() };
      const body = CanonicalSubmitChatInputRequestSchema.parse({ ...answer, clientRequestId: attempt.current.id });
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      if (!mounted.current) return;
      await fetchAuthenticatedJson({
        url: buildGatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(chatId)}/runs/${encodeURIComponent(request.runId)}/inputs/${encodeURIComponent(request.requestId)}`),
        token, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        schema: CanonicalChatInputSubmissionResponseSchema,
        errorMessage: "The answer could not be submitted. Try again.",
      });
      if (mounted.current) setSubmitted(true);
    } catch (error: unknown) {
      console.warn("[canonical-chat] Input submission failed:", error instanceof Error ? error.name : "UnknownError");
      if (mounted.current) setError("The answer could not be submitted. Try again.");
    } finally {
      if (mounted.current) {
        try { await onSettled(); } catch (error: unknown) {
          console.warn("[canonical-chat] Input refresh failed:", error instanceof Error ? error.name : "UnknownError");
          if (mounted.current) setError("Could not refresh chat. Try again.");
        }
        if (mounted.current) setSubmitting(false);
      }
      inFlight.current = false;
    }
  }

  return <View style={styles.card}>
    <Text style={styles.text}>{request.title}</Text>
    {request.safeDescription ? <Text style={styles.text}>{request.safeDescription}</Text> : null}
    {actionable ? <>
      {request.questions?.map(question => <View key={question.questionId} style={styles.question}>
        <Text style={styles.text}>{question.question}</Text>
        {question.options?.map(option => {
          const selected = own(answers, question.questionId)?.includes(option.label) ;
          return <Pressable key={option.label} accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
            accessibilityState={{ checked: !!selected, disabled: submitting }} disabled={submitting}
            style={[styles.button, selected ? styles.selected : undefined]}
            onPress={() => {
              if (!question.multiSelect) setOther(current => withValue(current, question.questionId, false));
              setAnswers(current => withValue(current, question.questionId, question.multiSelect
                ? own(current, question.questionId)?.includes(option.label) ? own(current, question.questionId)!.filter(value => value !== option.label) : [...own(current, question.questionId) ?? [], option.label]
                : [option.label]));
            }}>
            <Text style={styles.text}>{option.label}</Text>
            {option.description ? <Text style={styles.text}>{option.description}</Text> : null}
          </Pressable>;
        })}
        {question.options?.length && question.allowOther ? <Pressable
          accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
          accessibilityState={{ checked: !!own(other, question.questionId), disabled: submitting }} disabled={submitting}
          style={styles.button} onPress={() => {
            setOther(current => withValue(current, question.questionId, question.multiSelect ? !own(current, question.questionId) : true));
            if (!question.multiSelect) setAnswers(current => withValue(current, question.questionId, []));
          }}><Text style={styles.text}>Other</Text></Pressable> : null}
        {(!question.options?.length || own(other, question.questionId)) ? <TextInput secureTextEntry={question.secret} accessibilityLabel={`Your answer: ${question.question}`} placeholder="Your answer"
          placeholderTextColor={styles.placeholder.color} style={[styles.button, styles.text]} maxLength={400}
          editable={!submitting} value={own(custom, question.questionId) ?? ""}
          onChangeText={value => setCustom(current => withValue(current, question.questionId, value))} /> : null}
      </View>)}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: submitting || !complete }}
        disabled={submitting || !complete} onPress={() => void submit()} style={styles.button}>
        <Text style={styles.text}>{submitting ? "Submitting…" : "Submit answer"}</Text>
      </Pressable>
    </> : <Text style={styles.text}>{request.resolved ? request.reason === "expired" ? "This question has expired." : request.reason === "cancelled" ? "Input cancelled" : "Answer submitted" : submitted ? "Answer submitted" : request.submitted ? "Answer submitted; awaiting confirmation." : expired ? "This question has expired." : request.questions?.length ? "Input closed" : "Answering is unavailable for this request. Stop the run and try again."}</Text>}
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create(theme => ({
  card: { padding: 12, gap: 8, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12 },
  question: { gap: 8 },
  text: { color: theme.colors.foreground },
  placeholder: { color: theme.colors.mutedForeground },
  button: { padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 },
  selected: { backgroundColor: theme.colors.muted },
}));

import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { BotInteractionPayload } from "@matrix-os/contracts";

import { Button, TextField } from "@/components/ui";
import { DISABLED_OPACITY, PRESSED_OPACITY } from "@/components/ui/pressable-state";

import { InteractionCard } from "./InteractionCard";

type Question = Extract<BotInteractionPayload, { kind: "question" }>["questions"][number];

/** One list of answers per question id, as the server takes them. */
export type QuestionAnswers = Record<string, string[]>;

// The server's limits on an answer.
const MAX_TYPED_LENGTH = 400;
const MAX_ANSWER_BYTES = 700;
const MAX_CHOICES = 10;

const encodedLength = (value: string) => new TextEncoder().encode(value).byteLength;

export interface QuestionCardProps {
  /** "Question", from the copy every surface shares. */
  label: string;
  questions: readonly Question[];
  /** An answer is on its way to the server. */
  sending?: boolean;
  error?: string | null;
  onAnswer: (answers: QuestionAnswers) => void;
  testID?: string;
}

/** What an agent asks the person: choices, typed answers, or both. */
export function QuestionCard({ label, questions, sending = false, error, onAnswer, testID }: QuestionCardProps) {
  const [chosen, setChosen] = useState<QuestionAnswers>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  const answers: QuestionAnswers = Object.fromEntries(questions.map((question) => {
    const choices = chosen[question.questionId] ?? [];
    const own = typed[question.questionId]?.trim();
    // A typed answer adds to several choices, and stands in for a single one.
    const given = question.multiSelect ? [...choices, ...(own ? [own] : [])] : own ? [own] : choices.slice(0, 1);
    return [question.questionId, given];
  }));
  const complete = questions.every((question) => answers[question.questionId].length > 0)
    && Object.values(answers).every((given) => given.every((answer) => encodedLength(answer) <= MAX_ANSWER_BYTES));

  const toggle = (question: Question, option: string) => {
    setChosen((current) => {
      const choices = current[question.questionId] ?? [];
      const next = !question.multiSelect
        ? [option]
        : choices.includes(option)
          ? choices.filter((choice) => choice !== option)
          : choices.length < MAX_CHOICES ? [...choices, option] : choices;
      return { ...current, [question.questionId]: next };
    });
    if (!question.multiSelect) setTyped((current) => ({ ...current, [question.questionId]: "" }));
  };

  return (
    <InteractionCard testID={testID} label={label} error={error}>
      {questions.map((question) => (
        <View key={question.questionId} style={styles.question}>
          <Text style={styles.prompt}>{question.question}</Text>
          {question.options?.map((option) => {
            const checked = chosen[question.questionId]?.includes(option.label) ?? false;
            return (
              <Pressable
                key={option.label}
                accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                accessibilityLabel={option.label}
                accessibilityState={{ checked, disabled: sending }}
                disabled={sending}
                onPress={() => toggle(question, option.label)}
                style={({ pressed }) => [
                  styles.option,
                  checked && styles.optionChecked,
                  sending && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.optionLabel}>{option.label}</Text>
                {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
              </Pressable>
            );
          })}
          {!question.options || question.allowOther ? (
            <TextField
              accessibilityLabel={`Answer ${question.header}`}
              placeholder={question.options ? "Other answer" : "Your answer"}
              value={typed[question.questionId] ?? ""}
              secureTextEntry={question.secret}
              maxLength={MAX_TYPED_LENGTH}
              editable={!sending}
              onChangeText={(value) => setTyped((current) => ({ ...current, [question.questionId]: value }))}
            />
          ) : null}
        </View>
      ))}
      <Button
        size="large"
        fullWidth
        label="Answer"
        disabled={!complete}
        loading={sending}
        onPress={() => onAnswer(answers)}
      />
    </InteractionCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  question: {
    gap: theme.v2.space[8],
  },
  prompt: {
    ...theme.v2.text.calloutSemiBold,
    color: theme.v2.colors.textDefault,
  },
  // The border is always there, so choosing an option does not move its text.
  option: {
    minHeight: theme.v2.size.tapTarget,
    justifyContent: "center",
    borderRadius: theme.v2.radius.control,
    borderWidth: theme.v2.borderWidth.emphasis,
    borderColor: "transparent",
    paddingHorizontal: theme.v2.space[12],
    paddingVertical: theme.v2.space[10],
    backgroundColor: theme.v2.colors.card,
  },
  optionChecked: {
    borderColor: theme.v2.colors.textDefault,
  },
  optionLabel: {
    ...theme.v2.text.labelMedium,
    color: theme.v2.colors.textDefault,
  },
  optionDescription: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));

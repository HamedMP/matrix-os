import { createHash } from "node:crypto";
import type { CanonicalSubmitChatInputRequest, UserInputQuestion } from "@matrix-os/contracts";

export function nativeInputId(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value : `input_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export function questionAnswers(questions: UserInputQuestion[], input: CanonicalSubmitChatInputRequest): string[][] {
  const answers = input.structuredAnswers ?? (questions.length === 1 && input.answer
    ? { [questions[0]!.questionId]: [input.answer] } : {});
  if (Object.keys(answers).length !== questions.length) throw new Error("Input answers unavailable");
  return questions.map(question => {
    const values = answers[question.questionId];
    if (!values?.length || values.some(value => !value.trim() || value.length > 32_000)
      || (!question.multiSelect && values.length !== 1)
      || (question.options && !question.allowOther && values.some(value => !question.options!.some(option => option.label === value)))) {
      throw new Error("Input answers unavailable");
    }
    return values;
  });
}

// Scoped to one active native run; no receipt survives the run's disposal.
export function inputSubmissionGate() {
  const receipts = new Map<string, { fingerprint: string; completion: Promise<void> }>();
  return (requestId: string, input: CanonicalSubmitChatInputRequest, submit: () => Promise<void>) => {
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = receipts.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new Error("Input already submitted"));
      return existing.completion;
    }
    if (receipts.size >= 32) {
      const oldest = receipts.keys().next().value;
      if (oldest !== undefined) receipts.delete(oldest);
    }
    const completion = Promise.resolve().then(submit).catch(error => {
      receipts.delete(requestId);
      throw error;
    });
    receipts.set(requestId, { fingerprint, completion });
    return completion;
  };
}

export function secretQuestion(question: string): boolean {
  return /\b(?:paste|enter|provide|supply|share)\b.{0,120}\b(?:token|password|secret|api[ -]?key|credential)\b/i.test(question);
}

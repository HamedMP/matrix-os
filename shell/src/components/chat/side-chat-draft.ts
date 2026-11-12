/** Preserve an unsent main-chat draft when copying an answer from Side chat. */
export function appendSideChatAnswer(draft: string, answer: string): string {
  return draft.trim() ? `${draft}\n\n${answer}` : answer;
}

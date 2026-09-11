export function chatSendFailureMessage(reason: string): string {
  return `The message could not be sent. Reason: ${reason}`;
}

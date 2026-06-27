export interface ReplayableApprovalRequest {
  type: "approval:request";
  id: string;
  toolName: string;
  args: unknown;
  timeout: number;
  requestId?: string;
  eventId?: string;
}

export function stampApprovalRequestForReplay(
  sessionId: string | undefined,
  message: ReplayableApprovalRequest,
): ReplayableApprovalRequest {
  if (!sessionId || message.eventId) {
    return message;
  }

  return {
    ...message,
    eventId: `${sessionId}:approval:${message.id}`,
  };
}

export interface DispatchFailureKernelErrorMessage {
  type: "kernel:error";
  message: string;
  requestId?: string;
  eventId?: string;
}

export function buildDispatchFailureReplayMessage(
  input: {
    activeSessionId: string | undefined;
    requestId: string | undefined;
    clientMessage: string;
    stamp: (message: DispatchFailureKernelErrorMessage) => DispatchFailureKernelErrorMessage;
  },
): {
  liveMessage: DispatchFailureKernelErrorMessage;
  runMessage: DispatchFailureKernelErrorMessage | null;
} {
  const liveMessage = input.stamp({
    type: "kernel:error",
    message: input.clientMessage,
    requestId: input.requestId,
  });

  return {
    liveMessage,
    runMessage: input.activeSessionId ? liveMessage : null,
  };
}

import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  botSavedAnswerRecovery,
  botIntegrationAccessCopy,
  botInteractionCard,
  type BotInteraction,
  type BotInteractionPayload,
  type ResolveBotInteractionRequest,
  type ResolveBotInteractionResponse,
} from "@matrix-os/contracts";

import { Button } from "@/components/ui";
import { routineApprovalPreview } from "@matrix-os/ui/bot-routine-presentation";
import { RoutineApprovalCard } from "./RoutineApprovalCard";

import { approvalTitle, serviceLabel } from "../agent-copy";

import { AccountChoiceCard } from "./AccountChoiceCard";
import { ApprovalCard } from "./ApprovalCard";
import { ConnectContinueCard, ConnectRequestCard } from "./ConnectRequestCard";
import { InteractionCard, InteractionNote, RequestedAccessNotes, type RequestedAccess } from "./InteractionCard";
import { QuestionCard } from "./QuestionCard";

const SAVE_FAILED = "Could not save your response. Try again.";
const CONNECT_PAGE_FAILED = "Could not open the connection page. Try again.";
const STATUS_OUT_OF_DATE = "Status unavailable. Refresh to respond.";

// Why a request that is still listed cannot be answered.
const CLOSED_NOTES = {
  unavailable: "Only the designated person can respond.",
  expired: "Expired",
  resolved: "Resolved",
  cancelled: "Cancelled",
} as const;

export interface PendingInteractionProps {
  /** When supplied by Schedules, an old edit may be denied but not approved. */
  currentRoutineRevision?: number | null;
  interaction: BotInteraction;
  /** False while the agent's status could not be read again, so what is shown may be out of date. */
  actionsAvailable?: boolean;
  onResolve: (interactionId: string, input: ResolveBotInteractionRequest) => Promise<ResolveBotInteractionResponse>;
  /** Reads the agent's status again once the server has an answer. */
  onRefresh: () => Promise<unknown> | void;
  /** Opens the page where a service is connected. */
  onConnectUrl?: (url: string) => Promise<unknown> | void;
}

function titleOf(payload: BotInteractionPayload): string | undefined {
  if (payload.kind === "approval") return approvalTitle(payload);
  return payload.kind === "question" ? undefined : serviceLabel(payload.service);
}

function accessOf(payload: BotInteractionPayload): RequestedAccess | null {
  if (payload.kind === "connect_request") return botIntegrationAccessCopy(payload.service, payload.access);
  // An account choice stored before the server disclosed the access carries none.
  return payload.kind === "account_choice" && payload.access
    ? botIntegrationAccessCopy(payload.service, payload.access)
    : null;
}

/**
 * One thing an agent is waiting on the person for, drawn in the chat. The card
 * stays until the server has the answer; a failed request leaves it in place.
 */
export function PendingInteraction({
  interaction,
  actionsAvailable = true,
  onResolve,
  onRefresh,
  onConnectUrl,
  currentRoutineRevision,
}: PendingInteractionProps) {
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<{ connectUrl: string | null } | null>(null);
  const inFlight = useRef(false);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const recovery = !settled ? botSavedAnswerRecovery(interaction, now, savedRevision) : null;
  useEffect(() => {
    if (!interaction.recoveryAvailable && savedRevision === null) return;
    const delay = Date.parse(interaction.expiresAt) - Date.now();
    if (delay <= 0) { setNow(new Date().toISOString()); return; }
    const timer = setTimeout(() => setNow(new Date().toISOString()), Math.min(delay + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [interaction.expiresAt, interaction.recoveryAvailable, savedRevision]);

  const card = botInteractionCard(interaction, new Date().toISOString());
  const { payload, revision: baseRevision } = interaction;
  const label = interaction.kind === "approval" ? "Needs your approval" : card.title;
  const access = payload ? accessOf(payload) : null;
  const testID = `interaction-${interaction.interactionId}`;

  const resolve = async (action: string, input: ResolveBotInteractionRequest) => {
    if (input.kind !== "resume" && (!actionsAvailable || botInteractionCard(interaction, new Date().toISOString()).state !== "actionable")) {
      setNow(new Date().toISOString());
      return;
    }
    if (inFlight.current || settled || (input.kind === "resume" && (!recovery || recovery.expired || !actionsAvailable))) return;
    inFlight.current = true;
    setSending(action);
    setError(null);
    let response: ResolveBotInteractionResponse;
    try {
      response = await onResolve(interaction.interactionId, input);
    } catch (failure: unknown) {
      console.warn("[mobile] agent interaction failed", failure instanceof Error ? failure.name : "unknown");
      setError(input.kind === "resume" ? "Your answer is saved. Work could not resume. Try again." : SAVE_FAILED);
      return;
    } finally {
      inFlight.current = false;
      setSending(null);
    }
    if (response.continuationPending) setSavedRevision(response.interaction.revision);
    else { setSavedRevision(null); setSettled({ connectUrl: response.connectUrl ?? null }); }
    try {
      await onRefresh();
    } catch (failure: unknown) {
      // The screen says that the status could not be read; the answer is saved.
      console.warn("[mobile] agent status refresh failed", failure instanceof Error ? failure.name : "unknown");
    }
  };

  const openConnectPage = async (url: string) => {
    setError(null);
    try {
      await onConnectUrl?.(url);
    } catch (failure: unknown) {
      console.warn("[mobile] agent connection page failed", failure instanceof Error ? failure.name : "unknown");
      setError(CONNECT_PAGE_FAILED);
    }
  };

  if (recovery) return (
    <InteractionCard testID={testID} label="Saved answer" error={error}>
      <InteractionNote>Your answer is saved. Resuming work is pending confirmation.</InteractionNote>
      {recovery.expired ? <InteractionNote>This request has expired.</InteractionNote> : null}
      <Button label="Resume" disabled={recovery.expired || !actionsAvailable || sending !== null}
        onPress={() => void resolve("resume", { kind: "resume", baseRevision: recovery.revision })} />
    </InteractionCard>
  );

  if (settled) {
    const { connectUrl } = settled;
    // Connecting is finished on a page of its own, so that card stays to open it.
    return connectUrl ? (
      <ConnectContinueCard
        testID={testID}
        label={label}
        title={payload ? titleOf(payload) ?? "" : ""}
        access={access}
        error={error}
        onContinue={() => void openConnectPage(connectUrl)}
      />
    ) : null;
  }

  if (!payload || card.state !== "actionable") {
    if (payload?.kind === "approval" && payload.tool === "routine.activate") return <RoutineApprovalCard
      testID={testID} botId={interaction.agentId} preview={payload.preview} sending={null} error={null} stale={false}
      closed={CLOSED_NOTES[card.state === "actionable" ? "unavailable" : card.state]} onAllow={() => {}} onDeny={() => {}} />;
    return (
      <InteractionCard testID={testID} label={label}>
        <InteractionNote>{CLOSED_NOTES[card.state === "actionable" ? "unavailable" : card.state]}</InteractionNote>
        {access ? <RequestedAccessNotes access={access} /> : null}
      </InteractionCard>
    );
  }

  if (!actionsAvailable) {
    if (payload.kind === "approval" && payload.tool === "routine.activate") return <RoutineApprovalCard
      testID={testID} botId={interaction.agentId} preview={payload.preview} sending={null} error={null} stale={false}
      closed={STATUS_OUT_OF_DATE} onAllow={() => {}} onDeny={() => {}} />;
    return (
      <InteractionCard testID={testID} label={label} title={titleOf(payload)}>
        <InteractionNote>{STATUS_OUT_OF_DATE}</InteractionNote>
        {access ? <RequestedAccessNotes access={access} /> : null}
        {payload.kind === "question" ? payload.questions.map((question) => (
          <Text key={question.questionId} style={styles.question}>{question.question}</Text>
        )) : null}
      </InteractionCard>
    );
  }

  const sendingOneOf = <Action extends string>(...actions: Action[]): Action | null => (
    actions.find((action) => action === sending) ?? null
  );

  switch (payload.kind) {
    case "approval":
      if (payload.tool === "routine.activate") {
        const routine = routineApprovalPreview(payload.preview);
        const stale = Boolean(routine?.source.routineId && currentRoutineRevision !== undefined
          && routine.source.baseRoutineRevision !== currentRoutineRevision);
        return <RoutineApprovalCard testID={testID} botId={interaction.agentId} preview={payload.preview} sending={sending} error={error} stale={stale}
          onAllow={() => { if (routine && !stale) void resolve("approve", { kind: "approval", baseRevision, decision: "approve" }); }}
          onDeny={() => void resolve("deny", { kind: "approval", baseRevision, decision: "deny" })} />;
      }
      return (
        <ApprovalCard
          testID={testID}
          title={approvalTitle(payload)}
          preview={payload.preview}
          sending={sendingOneOf("approve", "deny")}
          error={error}
          onAllow={() => void resolve("approve", { kind: "approval", baseRevision, decision: "approve" })}
          onDeny={() => void resolve("deny", { kind: "approval", baseRevision, decision: "deny" })}
        />
      );
    case "question":
      return (
        <QuestionCard
          testID={testID}
          label={label}
          questions={payload.questions}
          sending={sending !== null}
          error={error}
          onAnswer={(structuredAnswers) => void resolve("answer", { kind: "question", baseRevision, structuredAnswers })}
        />
      );
    case "account_choice":
      return (
        <AccountChoiceCard
          testID={testID}
          label={label}
          title={serviceLabel(payload.service)}
          access={access}
          options={payload.options}
          sending={sending}
          error={error}
          onChoose={(connectionId) => void resolve(connectionId, { kind: "account_choice", baseRevision, connectionId })}
        />
      );
    case "connect_request":
      return (
        <ConnectRequestCard
          testID={testID}
          label={label}
          title={serviceLabel(payload.service)}
          benefit={payload.benefit}
          access={botIntegrationAccessCopy(payload.service, payload.access)}
          sending={sendingOneOf("start", "decline")}
          error={error}
          onConnect={() => void resolve("start", { kind: "connect_request", baseRevision, action: "start" })}
          onDecline={() => void resolve("decline", { kind: "connect_request", baseRevision, action: "decline" })}
        />
      );
  }
}

const styles = StyleSheet.create((theme) => ({
  question: {
    ...theme.v2.text.callout,
    color: theme.v2.colors.textDefault,
  },
}));

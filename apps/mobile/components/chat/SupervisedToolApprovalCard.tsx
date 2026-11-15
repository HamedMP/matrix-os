import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  supervisedToolApprovalCopy,
  type CanonicalChatApprovalDecision,
  type SupervisedToolApproval,
} from "@matrix-os/contracts";

import { Button, CheckIcon, CloseIcon, Icon, StatusDot } from "@/components/ui";
import { approvalDetailFields, approvalTitleParts } from "@/lib/supervised-tool-approval-details";

export const SUBMITTED_NOTE = "Decision submitted. Waiting for confirmation.";

// A search query is the person's own words, so it keeps its quotes and the
// body font; commands, paths and addresses are set in the code font.
const PROSE_SUBJECT = supervisedToolApprovalCopy("WebSearch").title;

export interface SupervisedToolApprovalCardProps {
  /** The card Desktop draws for this request (`supervisedToolApproval`). */
  approval: SupervisedToolApproval;
  /** The decision on its way to the computer, while one is. */
  sending?: CanonicalChatApprovalDecision | null;
  /** The computer took the decision; its recorded outcome has not arrived yet. */
  submitted?: boolean;
  error?: string | null;
  onDecision?: (decision: CanonicalChatApprovalDecision) => void;
  testID?: string;
}

/**
 * A request to use a tool in Supervised mode, laid out like Desktop's
 * `SupervisedToolApprovalCard`: what Matrix wants to do, why nothing happens
 * yet, the details on request, and Allow once or Not now.
 */
export function SupervisedToolApprovalCard({ approval, testID, ...answer }: SupervisedToolApprovalCardProps) {
  if (approval.kind === "waiting" || approval.kind === "expired") {
    return <OpenApproval approval={approval} testID={testID} {...answer} />;
  }
  return <SettledApproval testID={testID} allowed={approval.kind === "allowed"} line={approval.line} />;
}

type OpenRequest = Extract<SupervisedToolApproval, { kind: "waiting" | "expired" }>;

function OpenApproval({
  approval,
  sending = null,
  submitted = false,
  error,
  onDecision,
  testID,
}: Omit<SupervisedToolApprovalCardProps, "approval"> & { approval: OpenRequest }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const waiting = approval.kind === "waiting" ? approval : null;
  const details = waiting?.details;
  return (
    <View testID={testID} style={[styles.card, !waiting && styles.cardEnded]}>
      <View style={styles.header}>
        <View style={styles.label}>
          {waiting ? <StatusDot tone="waiting" /> : null}
          <Text style={styles.labelText}>{waiting ? "Needs your approval" : "Request expired"}</Text>
        </View>
        {details ? <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)} /> : null}
      </View>
      <ApprovalTitle title={approval.title} />
      <View style={styles.body}>
        <Text style={styles.summary}>{approval.summary}</Text>
        {detailsOpen && details ? <ApprovalDetails details={details} /> : null}
      </View>
      {waiting ? (
        <ApprovalActions request={waiting} submitted={submitted} sending={sending} onDecision={onDecision} />
      ) : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  );
}

/** Press once to open the details, again to close them. */
function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={12} onPress={onToggle}>
      <Text style={styles.toggleText}>{open ? "Hide details" : "See details"}</Text>
    </Pressable>
  );
}

/** Desktop's two answers, side by side; the one being sent shows a spinner. */
function ApprovalActions({ request, submitted, sending, onDecision }: {
  request: Extract<SupervisedToolApproval, { kind: "waiting" }>;
  submitted: boolean;
  sending: CanonicalChatApprovalDecision | null;
  onDecision?: (decision: CanonicalChatApprovalDecision) => void;
}) {
  if (submitted) return <Text style={styles.note}>{SUBMITTED_NOTE}</Text>;
  const choices = [
    ...(request.allowOnce ? [{ decision: "approve" as const, label: "Allow once", variant: "filled" as const }] : []),
    ...(request.decline ? [{ decision: "decline" as const, label: "Not now", variant: "outline" as const }] : []),
  ];
  if (choices.length === 0) return null;
  return (
    <View style={styles.actions}>
      {choices.map((choice) => (
        <View key={choice.decision} style={styles.action}>
          <Button
            fullWidth
            variant={choice.variant}
            label={choice.label}
            loading={sending === choice.decision}
            disabled={!onDecision || (sending !== null && sending !== choice.decision)}
            onPress={() => onDecision?.(choice.decision)}
          />
        </View>
      ))}
    </View>
  );
}

/** One line: the action, then what it acts on, cut short at the edge. */
function ApprovalTitle({ title }: { title: string }) {
  const { action, subject } = approvalTitleParts(title);
  return (
    <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
      {action}
      {subject ? " · " : null}
      {subject ? (
        action === PROSE_SUBJECT ? `“${subject}”` : <Text style={styles.titleCode}>{subject}</Text>
      ) : null}
    </Text>
  );
}

function ApprovalDetails({ details }: { details: string }) {
  const fields = approvalDetailFields(details);
  if (!fields) return <Text selectable style={[styles.detailValue, styles.code]}>{details}</Text>;
  return (
    <View style={styles.details}>
      {fields.map((field) => (
        <View key={field.key} style={styles.field}>
          <Text style={styles.detailLabel}>{field.label}</Text>
          <Text selectable style={[styles.detailValue, field.code && styles.code]}>{field.value}</Text>
        </View>
      ))}
    </View>
  );
}

function SettledApproval({ allowed, line, testID }: { allowed: boolean; line: string; testID?: string }) {
  const { theme } = useUnistyles();
  return (
    <View testID={testID} style={styles.settled}>
      <Icon icon={allowed ? CheckIcon : CloseIcon} size={14} color={theme.v2.colors.textSubtle} />
      <Text style={styles.settledText}>{line}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.v2.space[12],
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.colors.highlight,
    borderRadius: theme.v2.radius.modal,
    padding: theme.v2.space[16],
    backgroundColor: theme.v2.colors.background,
  },
  cardEnded: {
    borderColor: theme.v2.colors.borderSubtle,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.v2.space[12],
  },
  label: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
  },
  labelText: {
    ...theme.v2.text.footnoteMedium,
    color: theme.v2.colors.textSubtle,
  },
  toggleText: {
    ...theme.v2.text.footnoteMedium,
    color: theme.v2.colors.textSubtle,
  },
  title: {
    ...theme.v2.text.labelMedium,
    color: theme.v2.colors.textDefault,
  },
  titleCode: {
    fontFamily: theme.v2.fonts.mono,
    fontSize: theme.v2.text.caption.fontSize,
  },
  body: {
    gap: theme.v2.space[10],
    borderRadius: theme.v2.radius.control,
    paddingHorizontal: theme.v2.space[12],
    paddingVertical: theme.v2.space[10],
    backgroundColor: theme.v2.colors.card,
  },
  summary: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textDefault,
  },
  details: {
    gap: theme.v2.space[8],
  },
  field: {
    gap: theme.v2.space[2],
  },
  detailLabel: {
    ...theme.v2.text.footnoteMedium,
    color: theme.v2.colors.textSubtle,
  },
  detailValue: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textDefault,
  },
  code: {
    fontFamily: theme.v2.fonts.mono,
    fontSize: theme.v2.text.footnote.fontSize,
    lineHeight: theme.v2.text.footnote.lineHeight,
  },
  actions: {
    flexDirection: "row",
    gap: theme.v2.space[8],
  },
  action: {
    flex: 1,
  },
  note: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
  },
  error: {
    ...theme.v2.text.label,
    color: theme.v2.colors.danger,
  },
  settled: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[8],
  },
  settledText: {
    ...theme.v2.text.captionMedium,
    color: theme.v2.colors.textSubtle,
  },
}));

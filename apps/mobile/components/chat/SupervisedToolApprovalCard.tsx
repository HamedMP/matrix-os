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
export function SupervisedToolApprovalCard({
  approval,
  sending = null,
  submitted = false,
  error,
  onDecision,
  testID,
}: SupervisedToolApprovalCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (approval.kind === "allowed" || approval.kind === "declined" || approval.kind === "cancelled") {
    return <SettledApproval testID={testID} allowed={approval.kind === "allowed"} line={approval.line} />;
  }
  const waiting = approval.kind === "waiting";
  const details = waiting ? approval.details : undefined;
  return (
    <View testID={testID} style={[styles.card, !waiting && styles.cardEnded]}>
      <View style={styles.header}>
        <View style={styles.label}>
          {waiting ? <StatusDot tone="waiting" /> : null}
          <Text style={styles.labelText}>{waiting ? "Needs your approval" : "Request expired"}</Text>
        </View>
        {details ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: detailsOpen }}
            hitSlop={12}
            onPress={() => setDetailsOpen((open) => !open)}
          >
            <Text style={styles.toggleText}>{detailsOpen ? "Hide details" : "See details"}</Text>
          </Pressable>
        ) : null}
      </View>
      <ApprovalTitle title={approval.title} />
      <View style={styles.body}>
        <Text style={styles.summary}>{approval.summary}</Text>
        {detailsOpen && details ? <ApprovalDetails details={details} /> : null}
      </View>
      {waiting ? (
        submitted ? <Text style={styles.note}>{SUBMITTED_NOTE}</Text> : (
          approval.allowOnce || approval.decline ? (
            <View style={styles.actions}>
              {approval.allowOnce ? (
                <View style={styles.action}>
                  <Button
                    fullWidth
                    label="Allow once"
                    loading={sending === "approve"}
                    disabled={!onDecision || (sending !== null && sending !== "approve")}
                    onPress={() => onDecision?.("approve")}
                  />
                </View>
              ) : null}
              {approval.decline ? (
                <View style={styles.action}>
                  <Button
                    fullWidth
                    variant="outline"
                    label="Not now"
                    loading={sending === "decline"}
                    disabled={!onDecision || (sending !== null && sending !== "decline")}
                    onPress={() => onDecision?.("decline")}
                  />
                </View>
              ) : null}
            </View>
          ) : null
        )
      ) : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
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
      {fields.map((field, index) => (
        <View key={`${index}:${field.label}`} style={styles.field}>
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

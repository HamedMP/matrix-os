import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { supervisedToolApprovalCopy } from "@matrix-os/contracts";
import { Button, CheckIcon, CloseIcon, Icon } from "@/components/ui";
import { InteractionCard } from "@/components/agents/interactions/InteractionCard";
import { approvalDetailFields, approvalTitleParts } from "@/lib/supervised-tool-approval-details";

export const SUBMITTED_NOTE = "Decision submitted. Waiting for confirmation.";
export interface ApprovalAction {
  key: string;
  label: string;
  primary?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
}
export interface ApprovalRequestCardProps {
  title: string;
  summary?: string;
  /** Already privacy-filtered request details; never reconstructed from raw tool input. */
  details?: string;
  waiting: boolean;
  label?: string;
  outcome?: { line: string; allowed: boolean };
  submitted?: boolean;
  actions?: ApprovalAction[];
  children?: ReactNode;
  error?: string | null;
  testID?: string;
  accessibilityLabel?: string;
}

/** Shared presentation only. Each caller retains its own decision and authorization flow. */
export function ApprovalRequestCard({ title, summary, details, waiting, label, outcome,
  submitted = false, actions = [], children, error, testID, accessibilityLabel }: ApprovalRequestCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const stacked = actions.length > 2 || actions.some(action => action.label.length > 16);
  if (outcome && !children && !error) return <ApprovalOutcome {...outcome} testID={testID} />;
  const { action, subject } = approvalTitleParts(title);
  const titleContent = <>{action}{subject ? " · " : null}{subject ? (
    action === supervisedToolApprovalCopy("WebSearch").title ? `“${subject}”` : <Text style={styles.code}>{subject}</Text>
  ) : null}</>;
  return <InteractionCard testID={testID} accessibilityLabel={accessibilityLabel}
    waiting={waiting && !submitted} label={submitted ? "Decision submitted" : label ?? outcome?.line ?? "Needs your approval"}
    title={titleContent} error={error}
    headerAccessory={details ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: detailsOpen }}
      hitSlop={12} onPress={() => setDetailsOpen(open => !open)}>
      <Text style={styles.toggle}>{detailsOpen ? "Hide details" : "See details"}</Text>
    </Pressable> : undefined}>
    {summary || (detailsOpen && details) ? <View style={styles.body}>
      {summary ? <Text style={styles.summary}>{summary}</Text> : null}
      {detailsOpen && details ? <ApprovalDetails details={details} /> : null}
    </View> : null}
    {waiting && !submitted ? <View style={[styles.actions, stacked && styles.stacked]}>
      {actions.map(choice => <View key={choice.key} style={stacked ? undefined : styles.action}>
        <Button fullWidth label={choice.label} variant={choice.primary ? "filled" : "outline"}
          loading={choice.loading} disabled={choice.disabled} onPress={choice.onPress} />
      </View>)}
    </View> : null}
    {submitted ? <Text style={styles.summary}>{SUBMITTED_NOTE}</Text> : null}
    {children}
  </InteractionCard>;
}

function ApprovalDetails({ details }: { details: string }) {
  const fields = approvalDetailFields(details);
  if (!fields) return <Text selectable style={[styles.value, styles.code]}>{details}</Text>;
  return <View style={styles.details}>{fields.map(field => <View key={field.key} style={styles.field}>
    <Text style={styles.detailLabel}>{field.label}</Text>
    <Text selectable style={[styles.value, field.code && styles.code]}>{field.value}</Text>
  </View>)}</View>;
}
function ApprovalOutcome({ allowed, line, testID }: { allowed: boolean; line: string; testID?: string }) {
  const { theme } = useUnistyles();
  return <View testID={testID} style={styles.settled}>
    <Icon icon={allowed ? CheckIcon : CloseIcon} size={14} color={theme.v2.colors.textSubtle} />
    <Text style={styles.summary}>{line}</Text>
  </View>;
}
const styles = StyleSheet.create(theme => ({
  toggle: { ...theme.v2.text.footnoteMedium, color: theme.v2.colors.textSubtle },
  body: { gap: theme.v2.space[10], borderRadius: theme.v2.radius.control,
    paddingHorizontal: theme.v2.space[12], paddingVertical: theme.v2.space[10], backgroundColor: theme.v2.colors.card },
  summary: { ...theme.v2.text.caption, color: theme.v2.colors.textDefault },
  details: { gap: theme.v2.space[8] },
  field: { gap: theme.v2.space[2] },
  detailLabel: { ...theme.v2.text.footnoteMedium, color: theme.v2.colors.textSubtle },
  value: { ...theme.v2.text.caption, color: theme.v2.colors.textDefault },
  code: { fontFamily: theme.v2.fonts.mono, fontSize: theme.v2.text.footnote.fontSize, lineHeight: theme.v2.text.footnote.lineHeight },
  actions: { flexDirection: "row", gap: theme.v2.space[8] },
  stacked: { flexDirection: "column" },
  action: { flex: 1 },
  settled: { flexDirection: "row", alignItems: "center", gap: theme.v2.space[8] },
}));

import Svg, { Circle, Path } from "react-native-svg";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { chatSubagentPresentation, type ChatSubagent } from "@matrix-os/contracts/chat-subagent";
import type { CanonicalToolActivity } from "@matrix-os/contracts";

import { Spinner } from "@/components/chat/Spinner";
import { CheckIcon, CloseIcon, Icon, StopIcon, type IconData } from "@/components/ui";

const STEP_ICON_SIZE = 14;
const DETAIL_MAX_HEIGHT = 240;

type StepTone = "success" | "danger" | "subtle";

// A running step has no entry: it shows the turning loader instead.
const SETTLED_STEP_ICON: Record<Exclude<CanonicalToolActivity["state"], "running">, { icon: IconData; tone: StepTone }> = {
  completed: { icon: CheckIcon, tone: "success" },
  failed: { icon: CloseIcon, tone: "danger" },
  stopped: { icon: StopIcon, tone: "subtle" },
  partial: { icon: CheckIcon, tone: "subtle" },
};

/** One line of a reply's steps: what the agent did, and whether it is done, running or failed. */
export function ChatToolActivity({ activity }: { activity: CanonicalToolActivity }) {
  const { theme } = useUnistyles();
  const { colors } = theme.v2;
  if (activity.subagent) return <ChatSubagentActivity agent={activity.subagent} />;

  const settled = activity.state === "running" ? null : SETTLED_STEP_ICON[activity.state];
  const toneColor = { success: colors.success, danger: colors.danger, subtle: colors.textSubtle } as const;

  return (
    <StepLine
      accessibilityLabel={activity.preview ? `${activity.label}: ${activity.preview}` : activity.label}
      running={!settled}
      icon={settled
        ? <Icon icon={settled.icon} size={STEP_ICON_SIZE} color={toneColor[settled.tone]} />
        : <Spinner size={STEP_ICON_SIZE} color={colors.textSubtle} />}
      label={<>
        {activity.label}
        {activity.preview ? <Text style={styles.preview}>{" "}· {activity.preview}</Text> : null}
      </>}
      detail={activity.detail ? <Text selectable style={styles.detailText}>{activity.detail}</Text> : null}
    />
  );
}

/** A tool call the run's activity says nothing about: its label, in line with the steps. */
export function ChatToolCallLine({ label }: { label: string }) {
  return (
    <View testID="chat-tool-call-line" style={styles.row}>
      <View style={styles.iconBox} />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

function StepLine({ accessibilityLabel, running, icon, label, detail }: {
  accessibilityLabel: string;
  running: boolean;
  icon: ReactNode;
  label: ReactNode;
  /** What the line opens to when pressed; without it the line is not pressable. */
  detail: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const { theme } = useUnistyles();
  // Lines sit 8pt apart, so half of that on each side is all a line can add
  // to its own height as a target without reaching into its neighbours.
  const slop = theme.v2.space[4];

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded, disabled: !detail }}
        disabled={!detail}
        hitSlop={{ top: slop, bottom: slop }}
        onPress={() => setExpanded(!expanded)}
        style={styles.row}
      >
        <View style={styles.iconBox}>{icon}</View>
        <Text style={[styles.label, running && styles.labelRunning]}>{label}</Text>
      </Pressable>
      {expanded && detail ? (
        <ScrollView style={styles.detail} nestedScrollEnabled>{detail}</ScrollView>
      ) : null}
    </View>
  );
}

function ChatSubagentActivity({ agent }: { agent: ChatSubagent }) {
  const { theme } = useUnistyles();
  const view = chatSubagentPresentation(agent);
  const stroke = agent.status === "failed" ? theme.v2.colors.danger : theme.v2.colors.textSubtle;

  return (
    <StepLine
      accessibilityLabel={view.label}
      running={agent.status === "running"}
      icon={
        <Svg width={STEP_ICON_SIZE} height={STEP_ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" accessible={false}>
          {view.icon === "search" ? <><Circle cx={10.5} cy={10.5} r={6} /><Path d="m15 15 5 5" /></>
            : view.icon === "code" ? <Path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" />
            : view.icon === "review" ? <><Path d="M9 3h6l5 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><Path d="m8 12 3 3 5-6" /></>
            : <><Circle cx={6} cy={5} r={2} /><Circle cx={6} cy={19} r={2} /><Circle cx={18} cy={5} r={2} /><Path d="M6 7v10m0-5h5a7 7 0 0 0 7-5" /></>}
        </Svg>
      }
      label={`${agent.name} · ${view.status}`}
      detail={<>
        <Text style={styles.detailText}>{view.parent}</Text>
        {view.sections.map((section) => (
          <View key={section.title}>
            <Text style={styles.label}>{section.title}</Text>
            <Text selectable style={styles.detailText}>{section.text}</Text>
          </View>
        ))}
        {!view.sections.length ? <Text style={styles.detailText}>{view.empty}</Text> : null}
      </>}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.v2.space[8],
  },
  // As tall as one line of the label, so the icon stays beside the first line
  // when a label wraps.
  iconBox: {
    width: STEP_ICON_SIZE,
    height: theme.v2.text.caption.lineHeight,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    ...theme.v2.text.caption,
    flexShrink: 1,
    color: theme.v2.colors.textSubtle,
  },
  labelRunning: {
    ...theme.v2.text.captionMedium,
    color: theme.v2.colors.textDefault,
  },
  preview: {
    fontFamily: theme.v2.fonts.mono,
    fontSize: theme.v2.text.footnote.fontSize,
    color: theme.v2.colors.textSubtle,
  },
  detail: {
    maxHeight: DETAIL_MAX_HEIGHT,
    marginTop: theme.v2.space[6],
    marginLeft: STEP_ICON_SIZE + theme.v2.space[8],
  },
  detailText: {
    fontFamily: theme.v2.fonts.mono,
    fontSize: theme.v2.text.footnote.fontSize,
    lineHeight: theme.v2.text.footnote.lineHeight,
    color: theme.v2.colors.textSubtle,
  },
}));

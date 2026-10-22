import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { AgentMascot, Button, Icon, LockIcon, Sheet, SheetGrabber, StatusDot } from "@/components/ui";

import { AgentAccessSections, type AgentAccessSectionsProps } from "./AgentAccessSections";
import { connectionStatusLabel, serviceLabel } from "./agent-copy";
import { DetailsSection } from "./DetailsSection";

const MASCOT_SIZE = 48;
const LOCK_ICON_SIZE = 16;

export interface AgentDetailsSheetProps extends AgentAccessSectionsProps {
  visible: boolean;
  onClose: () => void;
  agent: {
    id: string;
    name: string;
    description?: string;
    /** Decides the mascot's colour. Saved agents have none: the server sends no category. */
    category?: string;
  };
  /** "Runs on …", or null when nothing is known about what the agent runs on. */
  runsOn: string | null;
  archiving: boolean;
  /** Asks to archive the agent. Left out while the agent itself is not known. */
  onArchive?: () => void;
}

/** The sheet over an agent's chat: its apps, what it runs on, and archiving it. */
export function AgentDetailsSheet({ visible, onClose, agent, runsOn, archiving, onArchive, ...access }: AgentDetailsSheetProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const connections = access.authority?.connections ?? [];
  // The sheet never grows over the top bar of the chat under it.
  const maxHeight = window.height - insets.top - theme.v2.size.topBar
    - theme.v2.space[10] - theme.v2.size.grabberHeight;

  return (
    <Sheet visible={visible} onClose={onClose} testID="agent-details-sheet">
      <View testID="agent-details">
        <SheetGrabber testID="agent-details-grabber" />
        <ScrollView
          testID="agent-details-scroll"
          style={{ maxHeight }}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + theme.v2.space[10] }]}
        >
          <View testID="agent-details-head" style={styles.head}>
            <AgentMascot id={agent.id} name={agent.name} category={agent.category} size={MASCOT_SIZE} />
            <View style={styles.fill}>
              <Text accessibilityRole="header" numberOfLines={1} style={styles.name}>{agent.name}</Text>
              {agent.description ? <Text numberOfLines={3} style={styles.description}>{agent.description}</Text> : null}
            </View>
          </View>
          {connections.length > 0 ? (
            <DetailsSection testID="agent-details-apps" label="Apps">
              {connections.map((connection) => (
                <View key={connection.service} testID={`agent-app-${connection.service}`} style={styles.app}>
                  <Text numberOfLines={1} style={[styles.fill, styles.appName]}>{serviceLabel(connection.service)}</Text>
                  <View style={styles.appStatus}>
                    {connection.state === "granted" ? <StatusDot tone="active" /> : null}
                    <Text style={styles.appStatusText}>{connectionStatusLabel(connection.state)}</Text>
                  </View>
                </View>
              ))}
            </DetailsSection>
          ) : null}
          {runsOn ? (
            <View testID="agent-details-runs-on" style={styles.runsOn}>
              <Icon icon={LockIcon} size={LOCK_ICON_SIZE} color={theme.v2.colors.textSubtle} />
              <Text style={[styles.fill, styles.runsOnText]}>{runsOn}</Text>
            </View>
          ) : null}
          <AgentAccessSections {...access} />
          {onArchive ? (
            <Button variant="outline" fullWidth label="Archive agent" loading={archiving} onPress={onArchive} />
          ) : null}
        </ScrollView>
      </View>
    </Sheet>
  );
}

// The grabber brings the 10pt above it, and stays in place while the rest scrolls.
const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.v2.space[18],
    paddingTop: theme.v2.space[18],
    paddingHorizontal: theme.v2.space[20],
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[12],
  },
  fill: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    ...theme.v2.text.subheading,
    color: theme.v2.colors.textDefault,
  },
  description: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
  },
  app: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[12],
    paddingVertical: theme.v2.space[10],
  },
  appName: {
    ...theme.v2.text.callout,
    color: theme.v2.colors.textDefault,
  },
  appStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
  },
  appStatusText: {
    ...theme.v2.text.label,
    color: theme.v2.colors.textSubtle,
  },
  runsOn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[10],
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.colors.borderHairline,
    borderRadius: theme.v2.radius.field,
    paddingHorizontal: theme.v2.space[14],
    paddingVertical: theme.v2.space[12],
  },
  runsOnText: {
    ...theme.v2.text.captionMedium,
    color: theme.v2.colors.textDefault,
  },
}));

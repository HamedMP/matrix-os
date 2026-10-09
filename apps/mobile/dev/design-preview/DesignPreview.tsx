import type { ComponentType } from "react";
import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";

import { ItemRow, SectionLabel } from "@/components/ui";

import {
  AgentApprovalFrame,
  AgentChatFrame,
  AgentDetailsFrame,
  AgentsListFrame,
  NewAgentFrame,
  TemplateSetupFrame,
} from "./agents";
import { ChatHomeFrame, ChatInProgressFrame, ChatTypingFrame } from "./chat/ChatFrames";
import { ModelSheetFrame } from "./chat/ModelSheetFrame";
import { ComponentsGallery } from "./ComponentsGallery";
import { SidePanelOverScreen } from "./panel";
import { NewProjectFrame, ProjectFrame, ProjectMenuFrame, ProjectsListFrame, RenameProjectFrame } from "./projects";

/** Frame C2: the side panel open over the new chat. */
function SidePanelOverChatFrame() {
  return (
    <SidePanelOverScreen>
      <ChatHomeFrame />
    </SidePanelOverScreen>
  );
}

// Development only: app/design-preview/[frame].tsx loads this module behind
// __DEV__, so nothing here reaches a production bundle.
const FRAMES: { name: string; Frame: ComponentType }[] = [
  { name: "components", Frame: ComponentsGallery },
  { name: "C1", Frame: ChatHomeFrame },
  { name: "C1b", Frame: ChatInProgressFrame },
  { name: "C1c", Frame: ChatTypingFrame },
  { name: "C3", Frame: ModelSheetFrame },
  { name: "C2", Frame: SidePanelOverChatFrame },
  { name: "P1", Frame: ProjectsListFrame },
  { name: "P1b", Frame: NewProjectFrame },
  { name: "P2", Frame: ProjectFrame },
  { name: "P3", Frame: ProjectMenuFrame },
  { name: "P4", Frame: RenameProjectFrame },
  { name: "A1", Frame: AgentsListFrame },
  { name: "A2", Frame: AgentChatFrame },
  { name: "A3", Frame: AgentApprovalFrame },
  { name: "A4", Frame: AgentDetailsFrame },
  { name: "A5", Frame: NewAgentFrame },
  { name: "A5b", Frame: TemplateSetupFrame },
];

export function DesignPreview({ frame }: { frame: string | undefined }) {
  const match = FRAMES.find((entry) => entry.name === frame);
  return match ? <match.Frame /> : <FrameList />;
}

function FrameList() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Text accessibilityRole="header" style={styles.heading}>Design preview</Text>
      <SectionLabel>Available frames</SectionLabel>
      <View>
        {FRAMES.map(({ name }) => (
          <ItemRow key={name} title={name} onPress={() => router.setParams({ frame: name })} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    gap: theme.v2.space[12],
    paddingHorizontal: theme.v2.space[20],
    backgroundColor: theme.v2.colors.background,
  },
  heading: {
    ...theme.v2.text.heading,
    color: theme.v2.colors.textDefault,
  },
}));

import { useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { AgentsListScreen } from "@/components/agents/AgentsListScreen";
import { NewAgentScreen } from "@/components/agents/NewAgentScreen";
import { TemplateSetupSheet } from "@/components/agents/TemplateSetupSheet";
import { filterTemplates, type AgentTemplate } from "@/components/agents/agent-templates";
import { TabBar } from "@/components/shell/TabBar";

import { SAMPLE_AGENT_ROWS, SAMPLE_SETUP_TEMPLATE, SAMPLE_TEMPLATES, SAMPLE_WAITING_COUNT } from "./sample";

function noop() {}

/** Frame A1: the agents list above the tab bar. */
export function AgentsListFrame() {
  return (
    <View style={styles.frame}>
      <AgentsListScreen
        state="ready"
        rows={SAMPLE_AGENT_ROWS}
        refreshing={false}
        onRefresh={noop}
        onRetry={noop}
        onNewAgent={noop}
        onOpenAgent={noop}
      />
      <TabBar activeRoute="agents" agentsBadgeCount={SAMPLE_WAITING_COUNT} onTabPress={noop} />
    </View>
  );
}

function TemplatesFrame({ setup }: { setup: AgentTemplate | null }) {
  const [query, setQuery] = useState("");
  const [template, setTemplate] = useState(setup);

  return (
    <>
      <NewAgentScreen
        state="ready"
        templates={filterTemplates(SAMPLE_TEMPLATES, query)}
        query={query}
        onChangeQuery={setQuery}
        onRetry={noop}
        onBack={noop}
        onSelectTemplate={setTemplate}
      />
      <TemplateSetupSheet
        template={template}
        creating={false}
        failed={false}
        onCreate={noop}
        onSetUpInChat={noop}
        onClose={() => setTemplate(null)}
      />
    </>
  );
}

/** Frame A5: the templates a new agent can start from. */
export function NewAgentFrame() {
  return <TemplatesFrame setup={null} />;
}

/** Frame A5b: the setup sheet open over the templates. */
export function TemplateSetupFrame() {
  return <TemplatesFrame setup={SAMPLE_SETUP_TEMPLATE} />;
}

const styles = StyleSheet.create({
  frame: {
    flex: 1,
  },
});

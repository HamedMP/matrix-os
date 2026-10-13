import { useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { AgentsListScreen } from "@/components/agents/AgentsListScreen";
import { InspirationSheet } from "@/components/agents/InspirationSheet";
import { NewAgentScreen } from "@/components/agents/NewAgentScreen";
import { TemplateSetupSheet } from "@/components/agents/TemplateSetupSheet";
import { ALL_CATEGORIES, buildAgentGallery, GALLERY_CATEGORIES } from "@/components/agents/agent-gallery";
import type { AgentInspiration } from "@/components/agents/agent-inspirations.generated";
import type { AgentTemplate } from "@/components/agents/agent-templates";
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

// The sample templates stand in for the computer's; the inspirations after
// them are the ones the app ships with.
function TemplatesFrame({ setup }: { setup: AgentTemplate | null }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [template, setTemplate] = useState(setup);
  const [inspiration, setInspiration] = useState<AgentInspiration | null>(null);
  const gallery = buildAgentGallery(SAMPLE_TEMPLATES, { query, category });

  return (
    <>
      <NewAgentScreen
        state="ready"
        templates={gallery.templates}
        inspirations={gallery.inspirations}
        query={query}
        onChangeQuery={setQuery}
        categories={GALLERY_CATEGORIES}
        category={category}
        onChangeCategory={setCategory}
        onRetry={noop}
        onBack={noop}
        onSelectTemplate={setTemplate}
        onSelectInspiration={setInspiration}
      />
      <TemplateSetupSheet
        template={template}
        creating={false}
        failed={false}
        onCreate={noop}
        onSetUpInChat={noop}
        onClose={() => setTemplate(null)}
      />
      <InspirationSheet
        inspiration={inspiration}
        onBuildInChat={noop}
        onClose={() => setInspiration(null)}
      />
    </>
  );
}

/** Frame A5: the gallery a new agent can start from. */
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

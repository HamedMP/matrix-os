import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import {
  AddIcon,
  AgentMascot,
  AgentsTabIcon,
  ChatIcon,
  CountBadge,
  DocumentIcon,
  FolderIcon,
  IconTile,
  ProviderLogo,
  RabbitMark,
  StatusDot,
  type Provider,
} from "@/components/ui";

import { PreviewCaption, PreviewRow, PreviewSection } from "./PreviewSection";

// One agent per body colour, then two that take their colour from their id.
const AGENTS: { id: string; name: string; category?: string }[] = [
  { id: "account-research", name: "Account research", category: "sales" },
  { id: "my-inbox", name: "My inbox", category: "productivity" },
  { id: "competitor-watch", name: "Competitor watch", category: "research" },
  { id: "launch-tracker", name: "Launch tracker", category: "operations" },
  { id: "release-notes", name: "Release notes", category: "engineering" },
  { id: "campaign-planner", name: "Campaign planner", category: "marketing" },
  { id: "invoice-chaser", name: "Invoice chaser", category: "finance" },
  { id: "moodboard", name: "Moodboard", category: "creative" },
  { id: "agent-1", name: "Agent without a category" },
  { id: "c", name: "Another agent without a category" },
];
const MASCOT_SIZES = [32, 36, 48];
const PROVIDERS: Provider[] = ["matrix", "claude", "codex", "hermes", "openclaw", "opencode", "pi"];

export function StatusDotsSection() {
  return (
    <PreviewSection title="Status dots">
      <PreviewRow>
        <StatusDot tone="waiting" accessibilityLabel="Waiting" />
        <PreviewCaption>Waiting</PreviewCaption>
        <StatusDot tone="active" accessibilityLabel="Active" />
        <PreviewCaption>Active</PreviewCaption>
      </PreviewRow>
    </PreviewSection>
  );
}

export function CountBadgesSection() {
  return (
    <PreviewSection title="Count badges">
      <PreviewRow>
        <CountBadge count={1} />
        <CountBadge count={2} />
        <CountBadge count={12} />
        <CountBadge count={0} />
        <PreviewCaption>1, 2, 12 and nothing for 0</PreviewCaption>
      </PreviewRow>
      <PreviewRow>
        <View>
          <IconTile icon={AgentsTabIcon} size={44} />
          <View style={styles.corner}>
            <CountBadge count={2} bordered />
          </View>
        </View>
        <PreviewCaption>With the ring, over an icon</PreviewCaption>
      </PreviewRow>
    </PreviewSection>
  );
}

export function IconTilesSection() {
  return (
    <PreviewSection title="Icon tiles">
      <PreviewRow>
        <IconTile icon={DocumentIcon} size={36} />
        <IconTile icon={ChatIcon} size={40} tone="subtle" />
        <IconTile icon={FolderIcon} size={44} />
        <IconTile icon={FolderIcon} size={52} />
        <IconTile icon={AddIcon} size={44} shape="circle" iconSize={20} />
      </PreviewRow>
      <PreviewCaption>36, 40, 44, 52 and the round 44</PreviewCaption>
    </PreviewSection>
  );
}

export function AgentMascotSection() {
  return (
    <PreviewSection title="Agent mascot">
      {MASCOT_SIZES.map((size) => (
        <PreviewRow key={size}>
          {AGENTS.map((agent) => (
            <AgentMascot key={agent.id} {...agent} size={size} />
          ))}
        </PreviewRow>
      ))}
      <PreviewCaption>32, 36 and 48</PreviewCaption>
    </PreviewSection>
  );
}

export function ProviderLogosSection() {
  return (
    <PreviewSection title="Provider logos">
      <PreviewRow>
        {PROVIDERS.map((provider) => (
          <ProviderLogo key={provider} provider={provider} />
        ))}
      </PreviewRow>
      <PreviewCaption>Matrix, Claude, Codex, Hermes, OpenClaw, OpenCode, Pi at 18</PreviewCaption>
      <PreviewRow>
        {PROVIDERS.map((provider) => (
          <ProviderLogo key={provider} provider={provider} size={32} />
        ))}
      </PreviewRow>
    </PreviewSection>
  );
}

export function RabbitMarkSection() {
  return (
    <PreviewSection title="Rabbit mark">
      <PreviewRow>
        <RabbitMark />
        <RabbitMark height={20} />
        <RabbitMark height={14} />
      </PreviewRow>
      <PreviewCaption>40, 20 and 14 high</PreviewCaption>
    </PreviewSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  corner: {
    position: "absolute",
    top: -theme.v2.space[4],
    right: -theme.v2.space[4],
  },
}));

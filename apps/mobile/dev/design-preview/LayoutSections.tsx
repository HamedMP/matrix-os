import { View } from "react-native";
import { useUnistyles } from "react-native-unistyles";

import {
  AddIcon,
  AgentMascot,
  BackIcon,
  Button,
  ChatIcon,
  ChevronRightIcon,
  FolderIcon,
  Icon,
  IconTile,
  InfoIcon,
  ItemRow,
  MoreIcon,
  NewChatIcon,
  SheetActionHeader,
  SheetGrabber,
  SidePanelIcon,
  StatusDot,
  TopBar,
  TopBarButton,
} from "@/components/ui";

import { PreviewBleed, PreviewCaption, PreviewSection } from "./PreviewSection";

function noop() {}

function BackButton() {
  return <TopBarButton icon={BackIcon} iconSize={22} accessibilityLabel="Back" onPress={noop} />;
}

export function TopBarSection() {
  return (
    <PreviewSection title="Top bar">
      <PreviewCaption>Centred title</PreviewCaption>
      <PreviewBleed>
        <TopBar
          title="New chat"
          leading={<TopBarButton icon={SidePanelIcon} accessibilityLabel="Open side panel" onPress={noop} />}
          trailing={<TopBarButton icon={NewChatIcon} accessibilityLabel="New chat" onPress={noop} />}
        />
        <TopBar
          title="Portfolio"
          leading={<BackButton />}
          trailing={<TopBarButton icon={MoreIcon} accessibilityLabel="Project menu" onPress={noop} />}
        />
        <TopBar title="Only a back button" leading={<BackButton />} />
      </PreviewBleed>
      <PreviewCaption>No title, with a button</PreviewCaption>
      <PreviewBleed>
        <TopBar
          leading={<BackButton />}
          trailing={<Button variant="secondary" icon={AddIcon} label="New project" onPress={noop} />}
        />
      </PreviewBleed>
      <PreviewCaption>Start-aligned</PreviewCaption>
      <PreviewBleed>
        <TopBar
          align="start"
          title="Account research"
          subtitle="Runs before each meeting"
          titleLeading={<AgentMascot id="account-research" name="Account research" category="sales" size={32} />}
          leading={<BackButton />}
          trailing={<TopBarButton icon={InfoIcon} filled accessibilityLabel="Agent details" onPress={noop} />}
        />
        <TopBar align="start" title="New agent" leading={<BackButton />} />
      </PreviewBleed>
    </PreviewSection>
  );
}

export function ItemRowsSection() {
  const { theme } = useUnistyles();
  const chevron = <Icon icon={ChevronRightIcon} size={18} color={theme.v2.colors.textSubtle} />;

  return (
    <PreviewSection title="Item rows">
      <PreviewCaption>Compact</PreviewCaption>
      <View>
        <ItemRow
          leading={<IconTile icon={ChatIcon} size={40} tone="subtle" />}
          title="Weekly report"
          titleAccessory={<StatusDot tone="waiting" />}
          subtitle="Approve before sending"
          meta="1h"
          onPress={noop}
        />
        <ItemRow
          leading={<AgentMascot id="my-inbox" name="My inbox" category="productivity" />}
          title="My inbox"
          titleAccessory={<StatusDot tone="active" />}
          subtitle="3 drafts ready to review"
          meta="9:12"
          onPress={noop}
        />
        <ItemRow
          leading={<IconTile icon={ChatIcon} size={40} tone="subtle" />}
          title="A chat whose title is too long to fit on a single line of the row"
          subtitle="And a last message that is also longer than the space it has to sit in"
          meta="Yesterday"
          onPress={noop}
        />
        <ItemRow leading={<IconTile icon={ChatIcon} size={40} tone="subtle" />} title="Title only" onPress={noop} />
      </View>
      <PreviewCaption>Comfortable</PreviewCaption>
      <View>
        <ItemRow
          density="comfortable"
          gap={14}
          leading={<IconTile icon={FolderIcon} size={44} />}
          title="Portfolio"
          subtitle="12 chats · Updated today"
          trailing={chevron}
          onPress={noop}
        />
        <ItemRow
          density="comfortable"
          leading={<IconTile icon={AddIcon} size={44} shape="circle" iconSize={20} />}
          title="Start from scratch"
          subtitle="Describe it in your own words"
          trailing={chevron}
          onPress={noop}
        />
        <ItemRow
          density="comfortable"
          leading={<AgentMascot id="inbox-triage" name="Inbox triage" category="productivity" />}
          title="Inbox triage"
          subtitle="Sorts your inbox and drafts replies"
          trailing={chevron}
          onPress={noop}
        />
      </View>
    </PreviewSection>
  );
}

export function SheetSection() {
  return (
    <PreviewSection title="Sheet">
      <SheetGrabber />
      <SheetActionHeader title="Rename project" confirmLabel="Save" onConfirm={noop} onCancel={noop} />
      <SheetActionHeader title="New project" confirmLabel="Create" confirmDisabled onConfirm={noop} onCancel={noop} />
      <SheetActionHeader title="New project" confirmLabel="Create" confirmLoading onConfirm={noop} onCancel={noop} />
    </PreviewSection>
  );
}

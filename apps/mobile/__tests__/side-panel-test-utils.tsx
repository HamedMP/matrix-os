import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

import { SidePanel, type SidePanelProps } from "../components/shell/SidePanel";

type Chat = CanonicalChatRecord["chat"];

interface ChatOverrides {
  id: string;
  title?: string;
  attention?: Chat["attention"];
  lastMessagePreview?: string;
  updatedAt?: string;
  activityAt?: string;
  projectId?: string;
}

export function chatRecord(overrides: ChatOverrides): CanonicalChatRecord {
  return {
    chat: {
      id: overrides.id,
      ownerScope: { type: "personal", ownerId: "user_123" },
      title: overrides.title ?? "",
      lifecycle: "active",
      attention: overrides.attention ?? "none",
      revision: 1,
      messageCount: 1,
      lastMessagePreview: overrides.lastMessagePreview,
      activityAt: overrides.activityAt,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    } as Chat,
    projectId: overrides.projectId,
  };
}

/** Thursday 8 October 2026, 12:00 local time. */
export const NOW = new Date(2026, 9, 8, 12, 0, 0);

export const ONE_HOUR_AGO = new Date(2026, 9, 8, 11, 0, 0).toISOString();
export const YESTERDAY = new Date(2026, 9, 7, 9, 0, 0).toISOString();
export const MONDAY = new Date(2026, 9, 5, 12, 0, 0).toISOString();

/** The chats frame C2 shows: one that needs the person and two recent ones. */
export const C2_CHATS: CanonicalChatRecord[] = [
  chatRecord({
    id: "chat-weekly",
    title: "Weekly report",
    attention: "approval_required",
    lastMessagePreview: "Approve before sending",
    updatedAt: ONE_HOUR_AGO,
  }),
  chatRecord({
    id: "chat-sales",
    title: "Sales prep this week",
    lastMessagePreview: "Both briefs are ready",
    updatedAt: YESTERDAY,
  }),
  chatRecord({
    id: "chat-q4",
    title: "Q4 planning",
    lastMessagePreview: "Draft shared with the team",
    updatedAt: MONDAY,
  }),
];

export function ids(records: readonly CanonicalChatRecord[]): string[] {
  return records.map((record) => record.chat.id);
}

// The reanimated mock in jest.setup.js has no `cancelAnimation`, which the
// skeleton rows call when they unmount.
const reanimated = jest.requireMock<{ cancelAnimation?: unknown }>("react-native-reanimated");
reanimated.cancelAnimation ??= jest.fn();

/** Renders the panel with frame C2's content; returns the props, whose handlers are mocks. */
export function renderPanel(overrides: Partial<SidePanelProps> = {}): SidePanelProps {
  const props: SidePanelProps = {
    chats: C2_CHATS,
    projectCount: 3,
    now: NOW,
    onSearchQueryChange: jest.fn(),
    onNewChat: jest.fn(),
    onSelectChat: jest.fn(),
    onOpenProjects: jest.fn(),
    onOpenShared: jest.fn(),
    ...overrides,
  };
  render(<SidePanel {...props} />);
  return props;
}

/** The test IDs of the chat rows on screen, top to bottom. */
export function chatRows(): string[] {
  return screen
    .getAllByRole("button")
    .map((button) => button.props.testID as string | undefined)
    .filter((testID): testID is string => Boolean(testID?.startsWith("side-panel-chat-")));
}

export function typeSearch(text: string) {
  fireEvent.changeText(screen.getByLabelText("Search chats"), text);
}

/** Lets `ms` pass on Jest's fake timers. */
export function wait(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/** Types a query and waits out the pause before it is searched. Needs fake timers. */
export function search(text: string) {
  typeSearch(text);
  wait(300);
}

import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { useMemo, useState } from "react";
import { ConversationTranscript } from "../../components/conversation/transcript";
import { CHAT_CONTENT_WIDTH_CLASS } from "../../components/conversation/layout";
import type {
  ConversationActivityPresentation,
  ConversationTurnPresentation,
} from "../../components/conversation/presentation";
import { cn } from "../../lib/cn";
import {
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "../chat/canonical-composer-state";
import { SharedChatComposer } from "../chat/SharedChatComposer";

export const DUMMY_CHAT_ID = "frontend:dummy";
export const DUMMY_CHAT_TITLE = "Dummy";

const CATALOG = {
  revision: "frontend_showcase",
  drivers: [{
    kind: "codex",
    displayName: "Codex",
    adapterVersion: "showcase",
    capabilityClass: "coding_agent",
  }],
  instances: [{
    id: "codex_showcase",
    driverKind: "codex",
    displayName: "Codex — Showcase",
    availability: "available",
    workspaceRequirement: "project_optional",
    catalogRevision: "frontend_showcase",
    models: [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      availability: "available",
      capabilities: ["reasoning", "tools", "vision"],
      supportsVision: true,
      supportsToolUse: true,
    }],
    options: [{
      id: "effort",
      label: "Reasoning",
      kind: "enum",
      values: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      defaultValue: "high",
      placement: "composer",
    }],
    skills: [{
      id: "review",
      displayName: "Review",
      description: "Review the current changes",
      invocation: "/review",
    }],
    commands: [{
      id: "status",
      displayName: "Status",
      description: "Show repository status",
      invocation: "/status",
    }],
    setupActions: [],
    supports: {
      rootChat: true,
      resume: true,
      cancellation: true,
      attachments: ["file", "image"],
      tools: ["read", "write"],
      approvals: true,
      userInput: true,
      worktrees: "optional",
      resources: ["file", "folder", "project"],
      interactionModes: ["default", "plan"],
      permissionModes: ["supervised", "full_access"],
    },
    defaultSelection: {
      instanceId: "codex_showcase",
      model: "gpt-5.6-sol",
      options: [{ id: "effort", value: "high" }],
    },
  }],
} satisfies CanonicalProviderCatalog;

const BASE_TIME = new Date("2026-08-31T14:00:00.000Z").getTime();
const PREVIEW_IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='320' viewBox='0 0 640 320'%3E%3Crect width='640' height='320' fill='%23f4f1e8'/%3E%3Crect x='24' y='24' width='592' height='48' rx='8' fill='%23ded8c8'/%3E%3Crect x='24' y='92' width='180' height='204' rx='10' fill='%23e7e1d4'/%3E%3Crect x='224' y='92' width='392' height='92' rx='10' fill='%23d5dfd8'/%3E%3Crect x='224' y='204' width='186' height='92' rx='10' fill='%23ded8c8'/%3E%3Crect x='430' y='204' width='186' height='92' rx='10' fill='%23ded8c8'/%3E%3C/svg%3E";

function activity(
  id: string,
  kind: ConversationActivityPresentation["kind"],
  state: ConversationActivityPresentation["state"],
  label: string,
  preview: string,
  previewKind: ConversationActivityPresentation["previewKind"] = "text",
  detail?: string,
): ConversationTurnPresentation["work"][number] {
  return {
    kind: "activity-group",
    id: `group_${id}`,
    activities: [{
      id,
      kind,
      state,
      label,
      preview,
      previewKind,
      copyText: preview,
      ...(detail ? { detail } : {}),
    }],
  };
}

const SHOWCASE_TURNS: ConversationTurnPresentation[] = [
  {
    id: "turn_dashboard",
    startedAt: BASE_TIME,
    endedAt: BASE_TIME + 12_000,
    active: false,
    user: {
      kind: "message",
      id: "user_dashboard",
      role: "user",
      phase: "commentary",
      markdown: "Build a release dashboard from the attached brief and screenshot.",
      copyText: "Build a release dashboard from the attached brief and screenshot.",
      timestamp: BASE_TIME,
      content: [
        { kind: "text", text: "Build a release dashboard from " },
        { kind: "reference", id: "brief", referenceKind: "file", label: "release-brief.md" },
        { kind: "text", text: " and use this screenshot as the visual reference." },
        { kind: "image", id: "dashboard-preview", label: "Dashboard preview", src: PREVIEW_IMAGE },
        { kind: "text", text: "\nUse the " },
        { kind: "reference", id: "matrix-os", referenceKind: "resource", label: "Matrix OS" },
        { kind: "text", text: " project and run " },
        { kind: "reference", id: "review", referenceKind: "invocation", label: "/review" },
        { kind: "text", text: " when it is ready." },
      ],
      references: [
        { id: "matrix-os", kind: "resource", label: "Matrix OS" },
        { id: "review", kind: "invocation", label: "/review" },
      ],
    },
    work: [
      activity("phase_done", "phase", "completed", "Prepared the workspace", "Loaded the desktop app and component inventory"),
      activity("reasoning_done", "reasoning", "completed", "Analyzed the request", "Mapped the brief to the existing desktop components"),
      activity("plan_done", "plan", "completed", "Created an implementation plan", "Header, metrics, activity table, responsive states"),
      activity("read_done", "read", "completed", "Read the design tokens", "desktop/src/renderer/src/design/tokens.css", "path"),
    ],
    final: {
      kind: "message",
      id: "assistant_summary",
      role: "assistant",
      phase: "final",
      timestamp: BASE_TIME + 12_000,
      copyText: "Implementation summary",
      markdown: [
        "## Implementation summary",
        "",
        "The dashboard is wired to the existing surface tokens and shared components.",
        "",
        "- Responsive metric cards",
        "- A filterable release table",
        "- Keyboard-accessible actions",
        "",
        "> The preview stays frontend-only and does not write release data.",
        "",
        "```tsx",
        "<ReleaseDashboard status=\"ready\" />",
        "```",
        "",
        "| Surface | Status |",
        "| --- | --- |",
        "| Electron Desktop | Ready |",
        "| Web Desktop | Review |",
        "",
        "Open `desktop/src/renderer/src/features/releases/ReleaseDashboard.tsx` or review the [design brief](https://matrix-os.com).",
      ].join("\n"),
    },
  },
  {
    id: "turn_validation",
    startedAt: BASE_TIME + 20_000,
    endedAt: BASE_TIME + 28_000,
    active: true,
    user: {
      kind: "message",
      id: "user_validation",
      role: "user",
      phase: "commentary",
      markdown: "Validate every state, prepare a preview, and ask before deploying.",
      copyText: "Validate every state, prepare a preview, and ask before deploying.",
      timestamp: BASE_TIME + 20_000,
    },
    work: [
      activity("reasoning_live", "reasoning", "running", "Thinking through edge cases", "Checking loading, empty, error, and success states"),
      activity("search_done", "search", "completed", "Searched the workspace", "ReleaseDashboard", "command"),
      activity("web_done", "web_search", "completed", "Checked platform guidance", "Desktop accessibility patterns"),
      activity("image_done", "image_inspection", "completed", "Inspected the reference image", "640 × 320 dashboard layout"),
      activity("command_done", "command", "completed", "Ran the focused test suite", "pnpm exec vitest run tests/desktop/release-dashboard.test.tsx", "command", "18 tests passed in 2.4s"),
      activity("edit_partial", "edit", "partial", "Updated responsive styles", "ReleaseDashboard.tsx", "path"),
      activity("file_done", "file_change", "completed", "Created the dashboard fixture", "release-dashboard-fixture.ts", "path"),
      activity("mcp_done", "mcp_tool", "completed", "Loaded the approved design context", "Figma desktop frame"),
      activity("dynamic_stopped", "dynamic_tool", "stopped", "Skipped analytics provisioning", "No external writes in showcase mode"),
      activity("delegate_done", "delegation", "completed", "Reviewed accessibility", "Keyboard and screen-reader pass"),
      activity("tool_failed", "tool", "failed", "Checked the preview endpoint", "Local preview is not running"),
      {
        kind: "notice",
        id: "notice_preview",
        phase: "commentary",
        tone: "warning",
        label: "Preview needs attention",
        markdown: "The UI is ready, but the local preview server is offline.",
        timestamp: BASE_TIME + 26_000,
        actions: [{ kind: "retry", turnId: "turn_validation", label: "Retry preview" }],
      },
      {
        kind: "notice",
        id: "notice_validation",
        phase: "commentary",
        tone: "success",
        label: "Visual checks completed",
        markdown: "Typography, spacing, focus states, tables, and code blocks were inspected.",
        timestamp: BASE_TIME + 27_000,
      },
      {
        kind: "request",
        id: "request_deploy",
        phase: "commentary",
        requestKind: "approval",
        requestId: "approval_deploy",
        state: "waiting",
        label: "Deploy the preview",
        detail: "This would publish the frontend showcase to the shared preview environment.",
        risk: "medium",
        timestamp: BASE_TIME + 27_500,
        actions: [
          { kind: "approval", requestId: "approval_deploy", decision: "approve", label: "Approve" },
          { kind: "approval", requestId: "approval_deploy", decision: "decline", label: "Decline" },
        ],
      },
      {
        kind: "request",
        id: "request_channel",
        phase: "commentary",
        requestKind: "input",
        requestId: "input_channel",
        state: "waiting",
        label: "Choose a release channel",
        detail: "Use dev, canary, beta, or stable.",
        timestamp: BASE_TIME + 28_000,
        actions: [{ kind: "input", requestId: "input_channel", label: "Continue" }],
      },
    ],
  },
];

export function DummyChatShowcase() {
  const [value, setValue] = useState("");
  const [selection, setSelection] = useState<CanonicalComposerSelection | null>(() => (
    createCanonicalComposerSelection(CATALOG)
  ));
  const [localTurns, setLocalTurns] = useState<ConversationTurnPresentation[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const turns = useMemo(() => [...SHOWCASE_TURNS, ...localTurns], [localTurns]);

  return (
    <div data-dummy-chat-showcase className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ConversationTranscript
        turns={turns}
        callbacks={{
          copyText: async (text) => {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
          },
          performAction: async (action, input) => {
            setFeedback(input ? `Submitted: ${input}` : `Selected: ${action.label}`);
          },
          canPerformAction: () => true,
          openFile: (path) => {
            setFeedback(`Open file: ${path}`);
            return true;
          },
        }}
      />
      {feedback ? (
        <p role="status" className={cn("mx-auto mb-2 w-full px-5 text-xs", CHAT_CONTENT_WIDTH_CLASS)} style={{ color: "var(--text-tertiary)" }}>
          {feedback}
        </p>
      ) : null}
      <div className={cn("mx-auto w-full shrink-0 px-5 pb-5", CHAT_CONTENT_WIDTH_CLASS)}>
        <SharedChatComposer
          value={value}
          onChange={setValue}
          onSubmit={(submission) => {
            if (!submission.text) return;
            const submittedAt = Date.now();
            setLocalTurns((current) => [...current, {
              id: `local_${submittedAt}`,
              startedAt: submittedAt,
              endedAt: submittedAt + 1_000,
              active: false,
              user: {
                kind: "message",
                id: `local_user_${submittedAt}`,
                role: "user",
                phase: "commentary",
                markdown: submission.text,
                copyText: submission.text,
                timestamp: submittedAt,
              },
              work: [],
              final: {
                kind: "message",
                id: `local_assistant_${submittedAt}`,
                role: "assistant",
                phase: "final",
                markdown: "This reply was generated locally for the component showcase.",
                copyText: "This reply was generated locally for the component showcase.",
                timestamp: submittedAt + 1_000,
              },
            }]);
            setValue("");
          }}
          busy={false}
          catalog={CATALOG}
          selection={selection}
          onSelectionChange={setSelection}
          instanceLocked={false}
          resources={[
            { kind: "file", id: "release-brief.md", label: "release-brief.md" },
            { kind: "project", id: "matrix-os", label: "Matrix OS" },
          ]}
          onAttach={() => setFeedback("Attachment picker opened")}
          attachments={<span className="text-xs" style={{ color: "var(--text-secondary)" }}>dashboard-reference.png</span>}
          footer={<span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>Frontend-only showcase</span>}
          placeholder="Try the frontend-only composer…"
          ariaLabel="Message Dummy chat"
        />
      </div>
    </div>
  );
}

export type HandoffSurface = "navigation" | "chat" | "terminal" | "files";
export type HandoffOwner = "MAT-298" | "MAT-299" | "MAT-300" | "MAT-301" | "MAT-302";
export type HandoffExecution = "baseline" | "dependency" | "combined-head";
export type HandoffVerification = "automated" | "manual" | "deferred";

export type HandoffRequirement =
  | "first-load"
  | "loading"
  | "ready"
  | "empty"
  | "search-empty"
  | "offline"
  | "reconnecting"
  | "error"
  | "retry"
  | "active"
  | "idle"
  | "waiting"
  | "completed"
  | "stopped"
  | "stale-live-resource"
  | "runtime-switch"
  | "auth-replacement"
  | "sign-out"
  | "reconnect"
  | "light-theme"
  | "dark-theme"
  | "default-window"
  | "narrow-window"
  | "sidebar-collapse"
  | "resize"
  | "zoom"
  | "macos-titlebar"
  | "keyboard-navigation"
  | "focus-restoration"
  | "screen-reader-names"
  | "reduced-motion"
  | "contrast"
  | "long-content"
  | "bounded-errors"
  | "canonical-navigation"
  | "back-forward"
  | "recents"
  | "mounted-resource"
  | "shutdown-drain"
  | "electron";

export interface HandoffTestEvidence {
  file: string;
  testName: string;
}

interface HandoffRegressionScenarioBase {
  id: string;
  surface: HandoffSurface;
  owner: HandoffOwner;
  execution: HandoffExecution;
  figmaNode?: string;
  requirements: readonly HandoffRequirement[];
  assertion: string;
}

export type HandoffRegressionScenario = HandoffRegressionScenarioBase & (
  | {
      verification: "automated";
      evidence: readonly HandoffTestEvidence[];
      note?: never;
    }
  | {
      verification: "manual" | "deferred";
      evidence?: never;
      note: string;
    }
);

const COMMON_STATE_REQUIREMENTS: readonly HandoffRequirement[] = [
  "first-load",
  "loading",
  "ready",
  "empty",
  "search-empty",
  "offline",
  "reconnecting",
  "error",
  "retry",
  "long-content",
  "bounded-errors",
];

const IDENTITY_REQUIREMENTS: readonly HandoffRequirement[] = [
  "runtime-switch",
  "auth-replacement",
  "sign-out",
  "reconnect",
  "stale-live-resource",
];

const ACCESSIBILITY_REQUIREMENTS: readonly HandoffRequirement[] = [
  "keyboard-navigation",
  "focus-restoration",
  "screen-reader-names",
  "reduced-motion",
];

const VISUAL_REQUIREMENTS: readonly HandoffRequirement[] = [
  "light-theme",
  "dark-theme",
  "default-window",
  "narrow-window",
  "resize",
];

const MANUAL_VISUAL_REQUIREMENTS: readonly HandoffRequirement[] = [
  "zoom",
  "contrast",
];

const PER_SURFACE_REQUIREMENTS: readonly HandoffRequirement[] = [
  ...COMMON_STATE_REQUIREMENTS,
  ...IDENTITY_REQUIREMENTS,
  ...ACCESSIBILITY_REQUIREMENTS,
  ...VISUAL_REQUIREMENTS,
  ...MANUAL_VISUAL_REQUIREMENTS,
  "electron",
];

const GLOBAL_REQUIREMENTS: readonly HandoffRequirement[] = [
  "active",
  "idle",
  "waiting",
  "completed",
  "stopped",
  "sidebar-collapse",
  "macos-titlebar",
  "canonical-navigation",
  "back-forward",
  "recents",
  "mounted-resource",
  "shutdown-drain",
];

function testEvidence(file: string, testName: string): HandoffTestEvidence {
  return { file, testName };
}

export const HANDOFF_REGRESSION_MATRIX: readonly HandoffRegressionScenario[] = [
  {
    id: "navigation-states",
    surface: "navigation",
    owner: "MAT-301",
    execution: "dependency",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/sidebar-navigation-shell.test.tsx",
        "filters bounded Recents by conversation, terminal, and project type",
      ),
      testEvidence(
        "tests/desktop/sidebar-navigation-shell.test.tsx",
        "offers the approved account actions and routes them through current behavior",
      ),
    ],
    figmaNode: "67:4368",
    requirements: COMMON_STATE_REQUIREMENTS,
    assertion: "Navigation, Recents filtering, account actions, and retry states use bounded generic copy.",
  },
  {
    id: "navigation-accessibility",
    surface: "navigation",
    owner: "MAT-301",
    execution: "dependency",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/e2e/desktop/operator.e2e.test.ts",
        "keeps the handoff surfaces named, keyboard reachable, and resize safe",
      ),
    ],
    figmaNode: "67:4368",
    requirements: ACCESSIBILITY_REQUIREMENTS,
    assertion: "Sidebar, history, breadcrumbs, Recents, and account menu remain named and keyboard operable.",
  },
  {
    id: "navigation-identity",
    surface: "navigation",
    owner: "MAT-302",
    execution: "combined-head",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/runtime-transition.test.ts",
        "atomically removes identifiers and attachments owned by the previous computer",
      ),
      testEvidence(
        "tests/desktop/sidebar-navigation-shell.test.tsx",
        "opens a canonical Hermes recent through the Gateway-backed loader",
      ),
    ],
    requirements: [
      ...IDENTITY_REQUIREMENTS,
      "canonical-navigation",
      "back-forward",
      "recents",
      "mounted-resource",
      "shutdown-drain",
    ],
    assertion: "History and Recents never retain prior-computer identities while cached resources follow lifecycle rules.",
  },
  {
    id: "navigation-visual-electron",
    surface: "navigation",
    owner: "MAT-302",
    execution: "baseline",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/e2e/desktop/operator.e2e.test.ts",
        "keeps the handoff surfaces named, keyboard reachable, and resize safe",
      ),
      testEvidence(
        "tests/e2e/desktop/operator.e2e.test.ts",
        "switches unified themes from Appearance settings",
      ),
    ],
    requirements: [
      ...VISUAL_REQUIREMENTS,
      "sidebar-collapse",
      "macos-titlebar",
      "electron",
    ],
    assertion: "The built Electron shell preserves named navigation and usable chrome across supported window sizes.",
  },
  {
    id: "navigation-manual-visual-audit",
    surface: "navigation",
    owner: "MAT-302",
    execution: "baseline",
    verification: "manual",
    requirements: MANUAL_VISUAL_REQUIREMENTS,
    assertion: "Zoom and contrast require a human comparison against the approved Figma handoff.",
    note: "macOS screenshots were inspected; automated pixel and contrast thresholds are not implemented.",
  },
  {
    id: "chat-states",
    surface: "chat",
    owner: "MAT-299",
    execution: "dependency",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/chat-tab-render.test.tsx",
        "shows loading, empty, and safe recovery states for conversation discovery",
      ),
      testEvidence(
        "tests/desktop/hermes-chat.test.ts",
        "keeps the current conversation visible when switching fails",
      ),
    ],
    figmaNode: "67:4472",
    requirements: [
      ...COMMON_STATE_REQUIREMENTS,
      "active",
      "idle",
      "waiting",
      "completed",
      "stopped",
    ],
    assertion: "Conversation index, history, composer, stop, error, offline, and recovery states remain bounded.",
  },
  {
    id: "chat-accessibility",
    surface: "chat",
    owner: "MAT-299",
    execution: "dependency",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/hermes-conversation-index.test.tsx",
        "keeps row opening separate from the hover and focus delete action",
      ),
      testEvidence(
        "tests/desktop/chat-tab-render.test.tsx",
        "opens the selected canonical conversation and exposes a Chat breadcrumb",
      ),
    ],
    figmaNode: "67:4472",
    requirements: ACCESSIBILITY_REQUIREMENTS,
    assertion: "Conversation switching, messages, tools, attachments, and composer expose deterministic focus and names.",
  },
  {
    id: "chat-identity",
    surface: "chat",
    owner: "MAT-302",
    execution: "combined-head",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/runtime-transition.test.ts",
        "discards a conversation index response that settles after the computer changes",
      ),
      testEvidence(
        "tests/desktop/hermes-chat.test.ts",
        "allowlists delete errors and discards a late success after runtime reset",
      ),
    ],
    requirements: [...IDENTITY_REQUIREMENTS, "mounted-resource", "shutdown-drain"],
    assertion: "Late history and stream events cannot repopulate a replaced runtime or authentication generation.",
  },
  {
    id: "chat-visual-electron",
    surface: "chat",
    owner: "MAT-302",
    execution: "baseline",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/e2e/desktop/operator.e2e.test.ts",
        "keeps the handoff surfaces named, keyboard reachable, and resize safe",
      ),
      testEvidence(
        "tests/e2e/desktop/hermes-conversations.e2e.test.ts",
        "discovers, switches, searches, deletes, and restores canonical conversations",
      ),
    ],
    requirements: [...VISUAL_REQUIREMENTS, "electron"],
    assertion: "Chat remains reachable by accessible name and usable after live Electron resize and theme changes.",
  },
  {
    id: "chat-manual-visual-audit",
    surface: "chat",
    owner: "MAT-302",
    execution: "baseline",
    verification: "manual",
    requirements: MANUAL_VISUAL_REQUIREMENTS,
    assertion: "Chat zoom and contrast require a human comparison against the approved Figma handoff.",
    note: "Figma nodes 145:2309 and 67:4551 were inspected directly; automated pixel and contrast thresholds are not implemented.",
  },
  {
    id: "terminal-states",
    surface: "terminal",
    owner: "MAT-300",
    execution: "dependency",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/terminals-tab.test.tsx",
        "renders canonical active, waiting, and closed lifecycle badges with relative activity",
      ),
      testEvidence(
        "tests/desktop/terminals-tab.test.tsx",
        "bounds loading and load-error states in the list surface",
      ),
    ],
    figmaNode: "67:5290",
    requirements: [
      ...COMMON_STATE_REQUIREMENTS,
      "active",
      "idle",
      "waiting",
      "completed",
      "stopped",
    ],
    assertion: "Session list and detail cover running, waiting, idle, ended, search, failure, and retry states.",
  },
  {
    id: "terminal-accessibility",
    surface: "terminal",
    owner: "MAT-300",
    execution: "dependency",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/terminals-tab.test.tsx",
        "keeps secondary row actions in an accessible overflow menu",
      ),
      testEvidence(
        "tests/desktop/terminals-tab.test.tsx",
        "uses the Figma list toolbar and reveals a bounded search-empty state",
      ),
    ],
    figmaNode: "67:5290",
    requirements: ACCESSIBILITY_REQUIREMENTS,
    assertion: "Session actions and detail controls remain named, keyboard operable, and focus-visible.",
  },
  {
    id: "terminal-identity",
    surface: "terminal",
    owner: "MAT-302",
    execution: "combined-head",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/runtime-transition.test.ts",
        "discards an in-flight shell create that settles after the computer changes",
      ),
      testEvidence(
        "tests/desktop/shell-sessions-store.test.ts",
        "drops a reorder response that settles after a runtime switch",
      ),
    ],
    requirements: [...IDENTITY_REQUIREMENTS, "mounted-resource", "shutdown-drain"],
    assertion: "Navigation preserves the intended live attachment, while runtime and auth changes drain the old one.",
  },
  {
    id: "terminal-visual-electron",
    surface: "terminal",
    owner: "MAT-302",
    execution: "baseline",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/e2e/desktop/terminal-sessions.e2e.test.ts",
        "renders the Figma-aligned list and preserves the mounted terminal buffer across list-detail navigation",
      ),
      testEvidence(
        "tests/e2e/desktop/operator.e2e.test.ts",
        "switches unified themes from Appearance settings",
      ),
    ],
    requirements: [...VISUAL_REQUIREMENTS, "electron"],
    assertion: "Terminal list/detail remains reachable and fitted after Electron resize and theme changes.",
  },
  {
    id: "terminal-manual-visual-audit",
    surface: "terminal",
    owner: "MAT-302",
    execution: "baseline",
    verification: "manual",
    requirements: MANUAL_VISUAL_REQUIREMENTS,
    assertion: "Terminal zoom and contrast require a human comparison against the approved Figma handoff.",
    note: "macOS list/detail screenshots were inspected; automated pixel and contrast thresholds are not implemented.",
  },
  {
    id: "files-states",
    surface: "files",
    owner: "MAT-298",
    execution: "dependency",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/files-workspace.test.tsx",
        "shows the designed empty-folder preview state",
      ),
      testEvidence(
        "tests/desktop/files-workspace.test.tsx",
        "retries a recoverable preview failure in place",
      ),
    ],
    figmaNode: "67:5663",
    requirements: COMMON_STATE_REQUIREMENTS,
    assertion: "Listing and preview cover loading, empty, unsupported, oversized, offline, error, and retry states.",
  },
  {
    id: "files-accessibility",
    surface: "files",
    owner: "MAT-298",
    execution: "dependency",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/files-workspace.test.tsx",
        "enters directories with the keyboard",
      ),
    ],
    figmaNode: "67:5663",
    requirements: ACCESSIBILITY_REQUIREMENTS,
    assertion: "List/grid navigation, sorting, breadcrumbs, upload, selection, and preview actions expose stable names.",
  },
  {
    id: "files-identity",
    surface: "files",
    owner: "MAT-302",
    execution: "combined-head",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/desktop/files-workspace.test.tsx",
        "clears the file preview and issues no stale request when the selected computer changes",
      ),
      testEvidence(
        "tests/desktop/files-workspace.test.tsx",
        "clears the preview when the session identity changes on the same computer",
      ),
    ],
    requirements: [...IDENTITY_REQUIREMENTS, "shutdown-drain"],
    assertion: "Selection, listing, preview, and late responses cannot cross a runtime or authentication boundary.",
  },
  {
    id: "files-visual-electron",
    surface: "files",
    owner: "MAT-302",
    execution: "baseline",
    verification: "automated",
    evidence: [
      testEvidence(
        "tests/e2e/desktop/files-handoff.e2e.test.ts",
        "captures the full-width list and grid overview states",
      ),
      testEvidence(
        "tests/e2e/desktop/operator.e2e.test.ts",
        "keeps the handoff surfaces named, keyboard reachable, and resize safe",
      ),
    ],
    requirements: [...VISUAL_REQUIREMENTS, "electron"],
    assertion: "List/grid and preview panes remain reachable after Electron resize and theme changes.",
  },
  {
    id: "files-manual-visual-audit",
    surface: "files",
    owner: "MAT-302",
    execution: "baseline",
    verification: "manual",
    requirements: MANUAL_VISUAL_REQUIREMENTS,
    assertion: "Files zoom and contrast require a human comparison against the approved Figma handoff.",
    note: "macOS Files screenshots were inspected; automated pixel and contrast thresholds are not implemented.",
  },
];

const SURFACES: readonly HandoffSurface[] = [
  "navigation",
  "chat",
  "terminal",
  "files",
];

export function assertHandoffMatrixCoverage(
  matrix: readonly HandoffRegressionScenario[],
): void {
  const missing: string[] = [];
  const ids = new Set<string>();

  for (const scenario of matrix) {
    if (ids.has(scenario.id)) missing.push(`duplicate-id:${scenario.id}`);
    ids.add(scenario.id);
    if (scenario.assertion.trim().length === 0) {
      missing.push(`assertion:${scenario.id}`);
    }
    if (scenario.verification === "automated") {
      if (scenario.evidence.length === 0) {
        missing.push(`evidence:${scenario.id}`);
      }
    } else if (scenario.note.trim().length === 0) {
      missing.push(`note:${scenario.id}`);
    }
  }

  for (const surface of SURFACES) {
    const scenarios = matrix.filter((scenario) => scenario.surface === surface);
    if (scenarios.length === 0) {
      missing.push(`surface:${surface}`);
      continue;
    }
    const covered = new Set(scenarios.flatMap((scenario) => scenario.requirements));
    for (const requirement of PER_SURFACE_REQUIREMENTS) {
      if (!covered.has(requirement)) missing.push(`${surface}:${requirement}`);
    }
  }

  const globallyCovered = new Set(
    matrix.flatMap((scenario) => scenario.requirements),
  );
  for (const requirement of GLOBAL_REQUIREMENTS) {
    if (!globallyCovered.has(requirement)) missing.push(`global:${requirement}`);
  }

  if (missing.length > 0) {
    throw new Error(`Desktop handoff matrix coverage missing: ${missing.join(", ")}`);
  }
}

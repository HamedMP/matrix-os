export type HandoffSurface = "navigation" | "chat" | "terminal" | "files";
export type HandoffOwner = "MAT-298" | "MAT-299" | "MAT-300" | "MAT-301" | "MAT-302";
export type HandoffExecution = "baseline" | "dependency" | "combined-head";

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

export interface HandoffRegressionScenario {
  id: string;
  surface: HandoffSurface;
  owner: HandoffOwner;
  execution: HandoffExecution;
  figmaNode?: string;
  requirements: readonly HandoffRequirement[];
  assertion: string;
}

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
  "contrast",
];

const VISUAL_REQUIREMENTS: readonly HandoffRequirement[] = [
  "light-theme",
  "dark-theme",
  "default-window",
  "narrow-window",
  "resize",
  "zoom",
];

const PER_SURFACE_REQUIREMENTS: readonly HandoffRequirement[] = [
  ...COMMON_STATE_REQUIREMENTS,
  ...IDENTITY_REQUIREMENTS,
  ...ACCESSIBILITY_REQUIREMENTS,
  ...VISUAL_REQUIREMENTS,
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

export const HANDOFF_REGRESSION_MATRIX: readonly HandoffRegressionScenario[] = [
  {
    id: "navigation-states",
    surface: "navigation",
    owner: "MAT-301",
    execution: "dependency",
    figmaNode: "67:4368",
    requirements: COMMON_STATE_REQUIREMENTS,
    assertion: "Navigation, Recents filtering, account actions, and retry states use bounded generic copy.",
  },
  {
    id: "navigation-accessibility",
    surface: "navigation",
    owner: "MAT-301",
    execution: "dependency",
    figmaNode: "67:4368",
    requirements: ACCESSIBILITY_REQUIREMENTS,
    assertion: "Sidebar, history, breadcrumbs, Recents, and account menu remain named and keyboard operable.",
  },
  {
    id: "navigation-identity",
    surface: "navigation",
    owner: "MAT-302",
    execution: "combined-head",
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
    requirements: [
      ...VISUAL_REQUIREMENTS,
      "sidebar-collapse",
      "macos-titlebar",
      "electron",
    ],
    assertion: "The built Electron shell preserves named navigation and usable chrome across supported window sizes.",
  },
  {
    id: "chat-states",
    surface: "chat",
    owner: "MAT-299",
    execution: "dependency",
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
    figmaNode: "67:4472",
    requirements: ACCESSIBILITY_REQUIREMENTS,
    assertion: "Conversation switching, messages, tools, attachments, and composer expose deterministic focus and names.",
  },
  {
    id: "chat-identity",
    surface: "chat",
    owner: "MAT-302",
    execution: "combined-head",
    requirements: [...IDENTITY_REQUIREMENTS, "mounted-resource", "shutdown-drain"],
    assertion: "Late history and stream events cannot repopulate a replaced runtime or authentication generation.",
  },
  {
    id: "chat-visual-electron",
    surface: "chat",
    owner: "MAT-302",
    execution: "baseline",
    requirements: [...VISUAL_REQUIREMENTS, "electron"],
    assertion: "Chat remains reachable by accessible name and usable after live Electron resize and theme changes.",
  },
  {
    id: "terminal-states",
    surface: "terminal",
    owner: "MAT-300",
    execution: "dependency",
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
    figmaNode: "67:5290",
    requirements: ACCESSIBILITY_REQUIREMENTS,
    assertion: "Session actions and detail controls remain named, keyboard operable, and focus-visible.",
  },
  {
    id: "terminal-identity",
    surface: "terminal",
    owner: "MAT-302",
    execution: "combined-head",
    requirements: [...IDENTITY_REQUIREMENTS, "mounted-resource", "shutdown-drain"],
    assertion: "Navigation preserves the intended live attachment, while runtime and auth changes drain the old one.",
  },
  {
    id: "terminal-visual-electron",
    surface: "terminal",
    owner: "MAT-302",
    execution: "baseline",
    requirements: [...VISUAL_REQUIREMENTS, "electron"],
    assertion: "Terminal list/detail remains reachable and fitted after Electron resize, zoom, and theme changes.",
  },
  {
    id: "files-states",
    surface: "files",
    owner: "MAT-298",
    execution: "dependency",
    figmaNode: "67:5663",
    requirements: COMMON_STATE_REQUIREMENTS,
    assertion: "Listing and preview cover loading, empty, unsupported, oversized, offline, error, and retry states.",
  },
  {
    id: "files-accessibility",
    surface: "files",
    owner: "MAT-298",
    execution: "dependency",
    figmaNode: "67:5663",
    requirements: ACCESSIBILITY_REQUIREMENTS,
    assertion: "List/grid navigation, sorting, breadcrumbs, upload, selection, and preview actions expose stable names.",
  },
  {
    id: "files-identity",
    surface: "files",
    owner: "MAT-302",
    execution: "combined-head",
    requirements: [...IDENTITY_REQUIREMENTS, "shutdown-drain"],
    assertion: "Selection, listing, preview, and late responses cannot cross a runtime or authentication boundary.",
  },
  {
    id: "files-visual-electron",
    surface: "files",
    owner: "MAT-302",
    execution: "baseline",
    requirements: [...VISUAL_REQUIREMENTS, "electron"],
    assertion: "List/grid and preview panes remain reachable after Electron resize, zoom, and theme changes.",
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

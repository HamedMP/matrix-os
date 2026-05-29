export const REQUIRED_TUI_ACTION_GROUPS = [
  "Account and Profile",
  "Instance",
  "Status and Doctor",
  "File Sync and Peers",
  "Shell and Remote Run",
  "Projects and Worktrees",
  "Sessions and Agents",
  "Reviews",
  "Tasks",
  "Previews",
  "Workspace Data",
  "Utility",
] as const;

export type TuiActionGroup = (typeof REQUIRED_TUI_ACTION_GROUPS)[number];
export type TuiActionDanger = "none" | "confirm" | "exact-phrase";
export type TuiActionHandler = "view" | "flow" | "direct-command" | "external-attach";
export type TuiActionPrerequisite = "auth" | "gateway" | "local-profile";
export type TuiActionRefreshTarget = "auth" | "profile" | "gateway" | "sessions" | "daemon" | "sync";

export interface TuiAction {
  id: string;
  title: string;
  group: TuiActionGroup;
  aliases: string[];
  intents: string[];
  shortcut?: string;
  directCommand?: string;
  requiresContext?: string[];
  prerequisites?: TuiActionPrerequisite[];
  refreshes?: TuiActionRefreshTarget[];
  danger: TuiActionDanger;
  confirmationPhrase?: string;
  handler: TuiActionHandler;
}

export interface TuiActionRegistryReport {
  duplicateIds: string[];
  duplicateShortcuts: string[];
  missingGroups: TuiActionGroup[];
  unsafeDestructiveActionIds: string[];
}

export const DEFAULT_TUI_ACTIONS: readonly TuiAction[] = [
  {
    id: "account.login",
    title: "Log in",
    group: "Account and Profile",
    aliases: ["auth", "signin", "profile"],
    intents: ["connect my account", "switch profile", "show whoami"],
    directCommand: "matrix login",
    shortcut: "l",
    prerequisites: ["local-profile"],
    refreshes: ["auth", "profile", "gateway", "sessions"],
    danger: "none",
    handler: "flow",
  },
  {
    id: "instance.restart",
    title: "Restart instance",
    group: "Instance",
    aliases: ["reboot", "services", "vps"],
    intents: ["restart matrix services", "recover my instance"],
    directCommand: "matrix instance restart",
    danger: "confirm",
    handler: "flow",
  },
  {
    id: "status.doctor",
    title: "Run doctor",
    group: "Status and Doctor",
    aliases: ["health", "diagnostics", "status"],
    intents: ["find what is broken", "check gateway and sync"],
    directCommand: "matrix doctor",
    shortcut: "d",
    prerequisites: ["local-profile"],
    refreshes: ["auth", "profile", "gateway", "daemon", "sync", "sessions"],
    danger: "none",
    handler: "view",
  },
  {
    id: "status.whoami",
    title: "Show whoami",
    group: "Status and Doctor",
    aliases: ["me", "identity", "profile"],
    intents: ["show active account", "check current handle", "show profile identity"],
    directCommand: "matrix whoami",
    prerequisites: ["local-profile"],
    refreshes: ["auth", "profile"],
    danger: "none",
    handler: "view",
  },
  {
    id: "sync.status",
    title: "Open sync status",
    group: "File Sync and Peers",
    aliases: ["files", "peers", "daemon"],
    intents: ["start syncing files", "pause sync", "show connected peers"],
    directCommand: "matrix sync status",
    danger: "none",
    handler: "view",
  },
  {
    id: "shell.new",
    title: "New shell session",
    group: "Shell and Remote Run",
    aliases: ["new terminal", "new zellij", "create shell"],
    intents: ["create a terminal", "start a persistent shell", "open a workspace session"],
    directCommand: "matrix shell new",
    shortcut: "n",
    prerequisites: ["auth", "gateway"],
    refreshes: ["sessions"],
    danger: "none",
    handler: "flow",
  },
  {
    id: "shell.sessions",
    title: "Open shell sessions",
    group: "Shell and Remote Run",
    aliases: ["terminal", "zellij", "remote run"],
    intents: ["attach to a session", "create a terminal", "run a command remotely"],
    directCommand: "matrix shell ls",
    shortcut: "s",
    prerequisites: ["auth", "gateway"],
    refreshes: ["sessions"],
    danger: "none",
    handler: "view",
  },
  {
    id: "projects.open",
    title: "Open projects",
    group: "Projects and Worktrees",
    aliases: ["repos", "branches", "worktrees"],
    intents: ["find a project", "open a worktree", "switch branch context"],
    danger: "none",
    handler: "view",
  },
  {
    id: "setup.agents",
    title: "Setup coding agents",
    group: "Sessions and Agents",
    aliases: ["setup", "codex", "claude", "migrate config"],
    intents: ["choose coding agent", "migrate local agent config", "set up codex and claude"],
    shortcut: "a",
    prerequisites: ["local-profile"],
    refreshes: ["profile", "sessions"],
    danger: "none",
    handler: "flow",
  },
  {
    id: "projects.create",
    title: "Create project",
    group: "Projects and Worktrees",
    aliases: ["github", "repo", "import"],
    intents: ["add github project", "create managed project"],
    danger: "none",
    handler: "flow",
  },
  {
    id: "sessions.agents",
    title: "Open coding sessions",
    group: "Sessions and Agents",
    aliases: ["agents", "codex", "hermes", "opencode"],
    intents: ["observe agent work", "take over a session", "start a coding agent"],
    danger: "none",
    handler: "view",
  },
  {
    id: "reviews.open",
    title: "Open reviews",
    group: "Reviews",
    aliases: ["pr", "greptile", "feedback"],
    intents: ["review current pull request", "show findings", "continue review loop"],
    danger: "none",
    handler: "view",
  },
  {
    id: "tasks.open",
    title: "Open tasks",
    group: "Tasks",
    aliases: ["issues", "todo", "linear"],
    intents: ["start work on a task", "archive a task", "link task to session"],
    danger: "none",
    handler: "view",
  },
  {
    id: "tasks.create",
    title: "Create task",
    group: "Tasks",
    aliases: ["new task", "issue"],
    intents: ["capture work", "start a new task"],
    danger: "none",
    handler: "flow",
  },
  {
    id: "previews.open",
    title: "Open previews",
    group: "Previews",
    aliases: ["localhost", "preview url", "app"],
    intents: ["open a preview", "copy preview url", "check preview status"],
    danger: "none",
    handler: "view",
  },
  {
    id: "workspace.deleteData",
    title: "Delete project workspace data",
    group: "Workspace Data",
    aliases: ["export", "delete", "workspace data"],
    intents: ["export workspace", "delete project workspace data"],
    danger: "exact-phrase",
    confirmationPhrase: "delete project workspace data",
    handler: "flow",
  },
  {
    id: "utility.palette",
    title: "Open command palette",
    group: "Utility",
    aliases: ["search", "commands", "palette"],
    intents: ["search commands", "find an action", "open command search"],
    shortcut: "/",
    danger: "none",
    handler: "view",
  },
  {
    id: "utility.help",
    title: "Open help",
    group: "Utility",
    aliases: ["commands", "shortcuts", "about"],
    intents: ["show keyboard shortcuts", "explain matrix cli", "open command help"],
    directCommand: "matrix --help",
    shortcut: "?",
    danger: "none",
    handler: "view",
  },
  {
    id: "utility.quit",
    title: "Quit",
    group: "Utility",
    aliases: ["exit", "close"],
    intents: ["leave the tui", "close matrix tui"],
    shortcut: "q",
    danger: "none",
    handler: "view",
  },
] as const;

const DESTRUCTIVE_PATTERN = /(?:delete|remove|destroy|restart|kill|rm)\b/i;

export function validateTuiActionRegistry(
  actions: readonly TuiAction[],
): TuiActionRegistryReport {
  const seen = new Set<string>();
  const shortcutOwners = new Map<string, string>();
  const duplicateIds = new Set<string>();
  const duplicateShortcuts = new Set<string>();
  const groups = new Set<TuiActionGroup>();
  const unsafe = new Set<string>();

  for (const action of actions) {
    if (seen.has(action.id)) {
      duplicateIds.add(action.id);
    }
    seen.add(action.id);
    groups.add(action.group);

    if (action.shortcut) {
      const owner = shortcutOwners.get(action.shortcut);
      if (owner && owner !== action.id) {
        duplicateShortcuts.add(action.shortcut);
      } else {
        shortcutOwners.set(action.shortcut, action.id);
      }
    }

    const destructiveText = `${action.id} ${action.title} ${action.directCommand ?? ""}`;
    if (DESTRUCTIVE_PATTERN.test(destructiveText) && action.danger === "none") {
      unsafe.add(action.id);
    }
    if (action.danger === "exact-phrase" && !action.confirmationPhrase?.trim()) {
      unsafe.add(action.id);
    }
  }

  return {
    duplicateIds: [...duplicateIds].sort(),
    duplicateShortcuts: [...duplicateShortcuts].sort(),
    missingGroups: REQUIRED_TUI_ACTION_GROUPS.filter((group) => !groups.has(group)),
    unsafeDestructiveActionIds: [...unsafe].sort(),
  };
}

export function getTuiActionById(id: string, actions: readonly TuiAction[] = DEFAULT_TUI_ACTIONS): TuiAction | undefined {
  return actions.find((action) => action.id === id);
}

export function getTuiActionByShortcut(shortcut: string, actions: readonly TuiAction[] = DEFAULT_TUI_ACTIONS): TuiAction | undefined {
  return actions.find((action) => action.shortcut === shortcut);
}

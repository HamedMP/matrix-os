import {
  AppWindowIcon,
  BoxIcon,
  DatabaseIcon,
  PuzzleIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Well-known home-directory locations shared by the classic file-browser
 * sidebar and the Windows XP explorer chrome (Other Places pane and the
 * address-bar location dropdown). Lives outside any component file so Fast
 * Refresh can preserve component state.
 */
export const FILE_BROWSER_LOCATIONS: { name: string; path: string; icon: LucideIcon }[] = [
  { name: "Agents", path: "agents", icon: UsersIcon },
  { name: "Apps", path: "apps", icon: AppWindowIcon },
  { name: "System", path: "system", icon: SettingsIcon },
  { name: "Plugins", path: "plugins", icon: PuzzleIcon },
  { name: "Modules", path: "modules", icon: BoxIcon },
  { name: "Data", path: "data", icon: DatabaseIcon },
];

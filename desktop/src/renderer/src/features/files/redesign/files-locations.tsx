import { AppWindow, Bot, Building2, Database, FolderKanban, House, Puzzle, Settings, Trash2 } from "lucide-react";
import type { BrowserEntry } from "../browser-entries";
import type { NavItemModel, NavSectionModel } from "./FilesSidebar";

export const HOME_NAV_ID = "home";
export const DRIVES_NAV_ID = "organization-drives";
export const TRASH_NAV_ID = "trash";

interface KnownLocation {
  folder: string;
  label: string;
  icon: NavItemModel["icon"];
  locked?: boolean;
}

// Top-level Matrix home folders shown under Locations, in this order, when they exist.
const KNOWN_LOCATIONS: KnownLocation[] = [
  { folder: "apps", label: "Apps", icon: <AppWindow /> },
  { folder: "projects", label: "Projects", icon: <FolderKanban /> },
  { folder: "data", label: "Data", icon: <Database /> },
  { folder: "plugins", label: "Plugins", icon: <Puzzle /> },
  { folder: "agents", label: "Agents", icon: <Bot />, locked: true },
  { folder: "system", label: "System", icon: <Settings />, locked: true },
];

export function locationNavId(folder: string): string {
  return `location:${folder}`;
}

/** Sidebar groups for the redesigned Files. Recents, Starred and Shared with me wait for their backend. */
export function buildFilesNav({
  rootEntries,
  drivesAvailable,
  trashCount,
}: {
  rootEntries: readonly BrowserEntry[];
  drivesAvailable: boolean;
  trashCount?: number;
}): { sections: NavSectionModel[]; footer: NavSectionModel } {
  const present = new Set(rootEntries.filter((entry) => entry.type === "directory").map((entry) => entry.name));
  const locations = KNOWN_LOCATIONS.filter((location) => present.has(location.folder)).map((location) => ({
    id: locationNavId(location.folder),
    label: location.label,
    icon: location.icon,
    locked: location.locked,
  }));
  const sections: NavSectionModel[] = [{ id: "home", items: [{ id: HOME_NAV_ID, label: "Matrix home", icon: <House /> }] }];
  if (locations.length > 0) sections.push({ id: "locations", label: "Locations", items: locations });
  if (drivesAvailable) sections.push({ id: "drives", label: "Organization drives", items: [{ id: DRIVES_NAV_ID, label: "All drives", icon: <Building2 /> }] });
  return {
    sections,
    footer: { id: "footer", items: [{ id: TRASH_NAV_ID, label: "Trash", icon: <Trash2 />, count: trashCount }] },
  };
}

/** Which sidebar row matches a folder path ("" is Matrix home; "apps" is Apps; deeper paths match nothing). */
export function activeNavIdForPath(path: string): string | null {
  if (path === "") return HOME_NAV_ID;
  return KNOWN_LOCATIONS.some((location) => location.folder === path) ? locationNavId(path) : null;
}

export function pathForNavId(id: string): string | null {
  if (id === HOME_NAV_ID) return "";
  if (id.startsWith("location:")) return id.slice("location:".length);
  return null;
}

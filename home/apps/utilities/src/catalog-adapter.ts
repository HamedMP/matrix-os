import { categories, tools } from "./vendor/lib/catalog.mjs";
import type { UtilityTool } from "./utilities-model";

/** App session behavior differs from the site's IndexedDB audio recovery. */
export const utilityCatalog: UtilityTool[] = tools.map((tool) => tool.slug === "audio-workspace" ? {
  ...tool,
  description: "Edit up to five audio files in temporary workspace tabs, with waveform previews and independent trim and effects settings.",
  howTo: "Add up to five recordings, select a tab, trim or adjust its sound, then preview and download a WAV for each file. Download your work before leaving the workspace.",
  limitations: "Each file is limited to 40 MB and three minutes. Tabs exist only in this workspace and are cleared when you leave or close the app. Browser codec and memory support vary by device.",
} : tool);
export const utilityCategories: string[] = categories;

/** The ribbon tabs of Sheets, built from the commands and what the ribbon shows. */
import type { RibbonTab } from "../../../../_shared/office-ui";
import type { SheetCommands } from "./commands";
import type { RibbonModel } from "./model";
import { homeTab } from "./tab-home";
import { fileTab } from "./tab-file";
import { assistantTab, dataTab, formulasTab, insertTab, reviewTab, viewTab } from "./tabs-more";

/** Every tab, in menu-bar order. */
export function buildSheetTabs(cmd: SheetCommands, model: RibbonModel): RibbonTab[] {
  return [fileTab(cmd, model.state), homeTab(cmd, model), insertTab(cmd), formulasTab(cmd, model), dataTab(cmd, model), reviewTab(cmd, model), viewTab(cmd, model), assistantTab(cmd, model)];
}

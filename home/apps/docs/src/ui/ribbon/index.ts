/**
 * The Docs ribbon: File (backstage), Home, Insert, Review, View and
 * Assistant, built as data for the shared office-ui `Ribbon`.
 *
 * `buildDocsRibbon(ctx)` is pure: each command calls one action of
 * `ctx.actions`, and its enabled, pressed and current values come from
 * `ctx.state`. Only commands the engine and the session can carry out are
 * offered; the workspace wires the actions (`useDocsRibbon`).
 */

import type { RibbonTab } from "../../../../_shared/office-ui";
import { fileTab } from "./file-tab";
import { homeTab } from "./home-tab";
import { assistantTab, insertTab, reviewTab, viewTab } from "./other-tabs";
import type { DocsRibbonContext } from "./types";

export function buildDocsRibbon(ctx: DocsRibbonContext): RibbonTab[] {
  return [fileTab(ctx), homeTab(ctx), insertTab(ctx), reviewTab(ctx), viewTab(ctx), assistantTab(ctx)];
}

export { caretFormat, documentStyles, runAt, tableRowOf, type CaretFormat, type DocumentStyle, type TableRowRef } from "./caret-format";
export { FONT_FAMILIES, FONT_SIZES, INDENT_STEP_PT, parseFontSize, stepFontSize } from "./home-tab";
export { VIEW_LABELS, ZOOM_LEVELS, stepZoom } from "./other-tabs";
export { BUILT_IN_STYLES, currentStyleId, styleChoices, type StyleChoice } from "./styles-model";
export type { DocsRibbonActions, DocsRibbonContext, DocsRibbonState, ToggleableFormat } from "./types";

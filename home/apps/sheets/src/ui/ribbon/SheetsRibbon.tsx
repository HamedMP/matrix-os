/**
 * The Sheets menu bar: File (backstage), Home, Insert, Formulas, Data,
 * Review, View and Assistant, on the shared Ribbon. Groups fold into
 * overflow buttons at narrow widths, so the grid below never moves.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Ribbon } from "../../../../_shared/office-ui";
import { type SheetCommandContext, type SheetCommands, createSheetCommands } from "./commands";
import { FunctionPicker } from "./FunctionPicker";
import type { RibbonModel } from "./model";
import { buildSheetTabs } from "./tabs";

export interface SheetsRibbonProps {
  context: Omit<SheetCommandContext, "openFunctionPicker">;
  model: Omit<RibbonModel, "colors">;
  trailing?: ReactNode;
}

const DEFAULT_COLORS = { text: "#c00000" as string | null, fill: "#fff2a8" as string | null };

export function SheetsRibbon({ context, model, trailing }: SheetsRibbonProps) {
  const [tab, setTab] = useState("home");
  const [collapsed, setCollapsed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [colors, setColors] = useState(DEFAULT_COLORS);
  const controller = context.controller;

  const commands = useMemo(() => {
    const base = createSheetCommands({ ...context, openFunctionPicker: () => setPicking(true) });
    return {
      ...base,
      "text-color": (color) => {
        setColors((current) => ({ ...current, text: color ?? null }));
        base["text-color"](color);
      },
      "fill-color": (color) => {
        setColors((current) => ({ ...current, fill: color ?? null }));
        base["fill-color"](color);
      },
    } satisfies SheetCommands;
  }, [context]);

  const tabs = useMemo(() => buildSheetTabs(commands, { ...model, colors }), [commands, model, colors]);

  return (
    <>
      <Ribbon
        label="Menu bar"
        className="sheets-ribbon"
        tabs={tabs}
        activeTab={tab}
        onTabChange={setTab}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        trailing={trailing}
      />
      <FunctionPicker
        open={picking}
        onCancel={() => setPicking(false)}
        onInsert={(name) => {
          setPicking(false);
          // After the dialog has handed the focus back, so the cell editor keeps it.
          window.setTimeout(() => controller.startEdit(`=${name}(`), 0);
        }}
      />
    </>
  );
}

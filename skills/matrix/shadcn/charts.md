# Charts for actual product decisions

Use a chart when its comparison helps the primary task. Derive bounded aggregates from owner-saved records through `window.MatrixOS.db`; do not copy registry demo arrays into the product as convincing activity. Keep amounts in their persisted units, currency/date ranges explicit and labels truthful. Show separate loading, empty, unavailable and retryable error states; zero is a valid value, not a loading placeholder. A chart should have a readable summary and a way to inspect the underlying values.

The [official chart guide](https://ui.shadcn.com/docs/components/base/chart), checked 2026-10-02, uses **Recharts 3**. It composes Recharts primitives with shadcn helpers rather than replacing them with a framework wrapper. Inspect the installed `chart` component and version-specific docs before editing older charts; preserve local changes using dry-run/diff. Select eligible dependencies under the project's package policy.

- Put an explicit height, min-height or aspect ratio on `ChartContainer`, with a responsive width and shrinking parent. An unmeasurable first render can leave the chart blank.
- Define meaningful series labels and semantic colors in `ChartConfig`. Use `var(--chart-1)` directly for full CSS color tokens; do not wrap an OKLCH token in `hsl(...)`. Series can reference generated `var(--color-SERIES)` tokens.
- Compose `ChartTooltip`/`ChartTooltipContent` and `ChartLegend`/`ChartLegendContent` when they help interpretation; avoid unlabeled color-only series.
- Enable `accessibilityLayer` on supported Recharts charts and verify keyboard/screen-reader behavior. Provide an accessible textual/table alternative for the important values.

Test narrow containers, long axis/legend labels, one record, zero values, large numbers, actual saved-data refresh, and empty/error states. Preserve the selected product palette with adequate contrast and non-color distinctions. Respect reduced motion, avoiding decorative or repeated data animations. A compact chart must not conceal essential values; resize or provide a contained scroll/table alternative when comparison requires it. Record observed viewport/container dimensions and interactions in BUILD-REPORT.md.

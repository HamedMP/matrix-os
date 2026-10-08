# Responsive apps and landing pages

Design for the available app container width, not the device label. A narrow Electron Desktop or Web Canvas window needs the same usable composition as a narrow mobile viewport. Use the observed viewport and container width; do not branch layout on user-agent strings. Keep the selected product style coherent as its layout changes.

## Compose for the space

- Use fluid grids, wrapping controls, flexible tracks such as `minmax(0, 1fr)`, and `min-width: 0` on shrinking flex/grid children. Give prose a readable maximum measure; use extra wide-window space for relevant content or a useful detail pane. Do not stretch controls or invent filler statistics to occupy space.
- Let the primary task determine breakpoints. On narrow windows, stack composer fields and actions in reading order; keep the primary action reachable and the draft intact when resizing. A sidebar can become accessible compact navigation or a sheet. Avoid a fixed minimum width for the whole app, fixed-height clipping, and viewport-wide children inside smaller containers.
- Preserve every meaningful field, action and state. Do not hide fields to make a screenshot fit. A table can become labeled rows/details if comparison remains clear. Use horizontal scrolling only for essential two-dimensional tables, timelines or boards: contain it in an explicit labeled region, provide visible overflow cues and keyboard access, and keep page-level scrolling usable. Do not mask clipped content with body `overflow-x: hidden`.
- Compact/mobile navigation needs a labeled button, an expanded state, usable links, visible keyboard focus and a reliable close action. For a modal sheet, manage focus, Escape, background inertness and return focus; hidden navigation must leave the tab order. Do not rely on hover to reveal actions.
- Use touch hit areas of at least 44×44px, even when the visible icon is smaller. Check long labels, translated-looking text, large text, keyboard focus, tab order and error messages. Controls and errors must remain reachable when the on-screen keyboard opens; preserve form values across layout changes.

For landing pages, let headings, CTA groups and feature layouts reflow; keep anchors and navigation usable at every width. Use a stable aspect ratio for imagery. Reframe or crop a real product preview for readability instead of shrinking a full desktop screenshot into unreadable mobile text. Avoid fixed-height heroes, page scroll locks and sticky elements that cover actions or focused content.

## Inspect actual widths

For both the working app and its landing page, inspect **360px, 390px, 600px, 820px, 1024px and 1440px** widths. Include intermediate resize behavior, not just endpoints. These are test widths, not mandatory CSS breakpoint values. Record the observed viewport and app container dimensions; outer window size can differ because of Matrix chrome.

Inspect Web Canvas, Web Desktop and Electron Desktop where available, plus Web Mobile and Native Mobile when supported. Resize the actual app window as well as the browser viewport. At each width verify primary create/edit and landing CTA flows, navigation, wrapping, focus, touch controls, essential scrolling, empty/loading/error/populated states, and persistence after reopen. Check supported themes and reduced motion.

Record tested widths, surfaces, screenshots and interaction results in BUILD-REPORT.md. If a tool cannot reach a width or surface, mark that check unavailable and state what was inspected; a large-window screenshot or successful build does not verify mobile responsiveness.

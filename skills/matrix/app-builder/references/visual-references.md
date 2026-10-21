# Visual references and style intake

Use this before choosing an app or landing-page direction, and when the user asks for a redesign. Actual screenshots are stronger visual context than a list of style adjectives. Read the user's references and existing DESIGN.md first.

## A short invitation

When the visual direction is not already clear, ask one concise question early:

> Do you have an app, screenshot, or style you want this to feel like? You can share an inspiration image or link, describe the mood, or let me choose a direction suited to the product.

Offer two or three concrete choices when helpful: bright/minimal, bold/neo-brutalist, or playful/retro. Ask about density, colors, or motion only when they affect the job. Skip questions already answered by the brief or supplied images. Continue independent data/scaffold work while waiting; use a stated default when the user delegates the choice. Do not turn reference selection into a mandatory approval gate.

## Choose an actual visual style

Style changes the whole interface: typography, shapes, borders, spacing, materials, imagery and interaction character, as well as color. Read the user’s mood and product intent. Bright, cheerful, playful, bold, nostalgic or calm are useful direction cues; calm does not require a dark or desaturated palette. Do not infer mood from sensitive personal information.

| Family | Visual decisions | Useful color direction |
| --- | --- | --- |
| Bright minimalism | Crisp type hierarchy, ample breathing room, restrained shapes, fine dividers, a confident primary action | Light neutral surfaces with cobalt, sky, mint or coral accents |
| Neo-brutalism | Heavy type, square or deliberately blunt corners, bold borders, offset solid shadows, direct controls | Paper/ink contrast with acid lime, yellow, cobalt or coral |
| Playful | Friendly shapes, expressive local SVG illustrations, varied but coherent scale, lively feedback on occasional actions | Cheerful paired accents, such as sky/coral or lavender/tangerine |
| Retro | Era-specific type from available local fonts, printed dividers, badges and original texture details | Cream, punchy orange, violet, cyan or warm red; avoid muddy contrast |
| Neumorphism | Soft raised/inset surfaces and gentle depth; reserve sculpted treatment for a few controls | Clean light tints with a saturated focus/accent; visible outlines and text distinguish every state |

These are starting directions, not templates or compulsory palettes. Choose one primary family and adapt its density to the task. An expense journal still needs aligned figures, a planner usable dates, and a creative studio room for content. Use style-specific illustrations and composition without adding irrelevant dashboards or oversized decorative cards. For neumorphism, never rely on shadows alone to identify inputs, selection, or disabled states; provide high-contrast outlines when needed.

If the user says “choose,” select a fitting family without delaying the build. If they request surprise/random styles, pick one coherent family/palette once, record it in DESIGN.md, and keep it stable across screens, refreshes and edits. For multiple proposals, deliberately vary families as well as colors. Do not randomize every component or reshuffle styles on launch.

Use named semantic tokens for background, surface, text, primary/secondary accent, border, focus, success and error. Choose readable foreground/background pairs; do not let an inherited muted brand palette erase the user’s chosen product style. Keep focus and status visible and non-color cues intact. Respect a requested light or dark direction; otherwise check both supported modes with the same style character. Matrix platform chrome/auth/billing continues to use its shared brand primitives. Generated products and their landing pages can have their own art direction.

## Research similar real products

When useful and the harness supports delegation, the builder may spawn one or two research subagents with separate responsibilities: one finds task/interaction references, another finds a contrasting visual direction. Use only available browser/search/capture tools. Give them the secret-free product brief, primary user task, target surface, and current user preferences. Keep implementation ownership with the builder.

Ask each researcher to return:

- Two or three relevant real app screens, with source URL, capture date, viewport, and a screenshot or image reference they actually inspected.
- The exact interaction shown: search/results, item detail, editor, checkout, dashboard, or another relevant flow.
- Useful observations about hierarchy, content density, typography, spacing, navigation, imagery, controls, and motion when observed.
- Why this pattern fits the requested job, and what should be adapted for Matrix.

For an accommodation product, investigate reservation search, map/results, filters and property detail screens; for a planner, investigate agenda/composer/detail flows; for a creative tool, investigate project browsing and editing. Prefer task-relevant screens over homepages or generic galleries. Do not claim a screenshot proves behavior you did not observe.

If delegation is unavailable, perform the same bounded research directly. If screenshot capture is unavailable, use user-provided images or accessible official screen images and state the limitation. A URL or text description alone is not inspected visual evidence. Do not waste build time retrying unavailable tools.

## Keep a small reference set

Save available captures under the owner project's `design/references/`, with a short `index.md`: source, date/viewport, observed screen, selected patterns, and why each helps. Preserve user attachments in that owner project rather than publishing them in the shared skill pack. Read/view the actual images before using them; a researcher’s summary is not a substitute for visual inspection.

Choose one primary direction and at most one supporting interaction reference. Offer two or three annotated screenshot directions when the user wants to choose. Otherwise select the best fit and record the choice in DESIGN.md. Include the concrete qualities to carry forward and the changes required for the user's own product. Learn hierarchy and interaction patterns; create original content, assets and components rather than copying another product's branding or claiming affiliation.

## Turn references into implementation decisions

Record audience, primary task, layout/density, type hierarchy, spacing scale, component/state patterns, palette roles, imagery, and motion purpose. Keep shared decisions in DESIGN.md; when a page needs an exception, save only that deviation in a small page-specific note and read both before editing. Do not regenerate or overwrite approved decisions from a fresh keyword query. Separate visual family (editorial, minimal, expressive) from page structure (hero, workflow, comparison) and from interaction rules. A finance journal and an accommodation search need different structures even if both are visually quiet.

Check long labels, text scaling, chip/badge reflow, visible keyboard focus, non-color status cues, cancellable/interrupted interactions, and reduced motion. A product style may define app-local semantic color/type/material tokens; preserve Matrix integration, sandbox, Vite/React/TypeScript, owner Postgres, and security contracts. Use local/inherited fonts and assets instead of remote font/CDN imports.

After building, compare a screenshot of the actual Matrix app with the selected references: task hierarchy, spacing, typography, state clarity and responsive fit. Refine the biggest mismatch. Keep the user's direction continuous across iterations, while verifying real functionality and persistence separately. Report the references actually viewed, the selected direction, and which rendered checks passed.

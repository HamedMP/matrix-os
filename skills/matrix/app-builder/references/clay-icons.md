# Matrix clay icons

Source of truth: [App icons · Clay](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1742-156).
Preserve owner-provided artwork. Download supplied Figma assets unchanged rather than recreating
them. Gallery uses local packaged SVGs; launcher-compatible PNGs may rasterize the same masters.

Use one puffy, inflated, toy-like object in soft matte plastic, front view, optically centred.
Its silhouette fills 60–75% of a 128px master (inside 16–112). Export generated art at 1024px.
Use rounded corners at least 6px and details at least 8px thick at master size, with no more
than three or four raised details. The shell applies the production corner radius of 22%.

Tiles use adjacent light steps of one Matrix brand scale: green, teal, gold, blue or neutral.
The object is white/neutral-25 or a different hue at step 300–500. Add one small accent in
a third hue. Avoid repeating tile hue and step on neighbouring apps. Focus's neutral-700→800
tile is the reference exception; keep at most one dark tile per screen. Coral is reserved for danger.

Light always comes from the top-left; shadows fall down. At 128px:

- Body: drop 0/12/18 at 38%, inner white −4/−6/8 at 85%, inner dark 5/8/12 at 35%.
- Part: drop 0/5/7 at 35%, inner white −2/−3/4 at 85%, inner dark 2/4/5 at 30%.
- Detail: drop 0/2.5/3 at 35%, inner white −1/−1.5/1.5 at 90%, inner dark 1/2/2 at 25%.
- One small white ellipse shine on the top-left of the object, blur 3, opacity 60–90%.
- Tile: thin white top inner highlight 0/2/3 at 80%, otherwise smooth matte with no texture.

Never add text, letters, numbers, outlines, line art, photos, metal, glass, neon, glow, a scene,
multiple main objects, tilted perspective, red or coral. Verify at 64px in Apps, 48px in the
launcher and 20px in a window tab, including a dark desktop background.

| Figma variant | Existing identity | Tile | Object and accent |
| --- | --- | --- | --- |
| Trip Companion | Atlas | blue-200→300 | light plane, gold sun |
| Receipt Inbox | Folio | green-200→300 | white receipt, teal check |
| Subscription Guardian | Subscriptions | gold-100→200 | teal shield, white arrows |
| Today Brief | Agenda | teal-100→200 | white calendar, blue header, gold rings |
| Focus Sessions | Focus | neutral-700→800 | white stopwatch, gold wedge |
| Workout History Coach | Workout Coach | gold-25→50 | blue dumbbell, gold heart |
| Expenses | Expense Tracker | blue-50→100 | green wallet, gold coin |
| To-do | Todo | teal-200→300 | white checklist, teal ticks |
| Games | Game Center | green-300→400 | white controller, blue/gold/teal buttons |

Do not map the wallet to Folio: its primary task is receipts. Do not assign Game Center's
controller to Chess, Backgammon, Tetris, Solitaire, Snake, Minesweeper or 2048.

Image prompt template:

```text
App icon, 1024×1024, one puffy inflated toy-like {OBJECT} in soft matte plastic.
Front view, centred, fills about 70% of the square tile, no perspective.
Simplify into chunky rounded shapes with {DETAILS} as at most three or four raised parts.
Object colour: {OBJECT_COLOUR}, different from the tile hue.
Accent: one small {ACCENT} in {ACCENT_COLOUR}.
Tile: smooth matte vertical gradient {TILE_TOP} to {TILE_BOTTOM}; no texture or scene.
Soft top-left studio light, bright top-left edges, soft bottom-right shading,
a soft downward shadow onto the tile, and one small top-left shine.
Calm, friendly, minimal, matching the Matrix clay siblings.
Avoid text, letters, numbers, logos, outlines, line art, flat 2D, photorealism,
metal, glass, neon, glow, multiple main objects, perspective, red and coral.
Fill the square canvas; the shell applies the final 22% corner radius.
```

Record the chosen tile/object/accent pair in the app's design notes. When adding a Figma variant,
use `App=<name>` in `App icon · Clay` and the layer name `app-icon/<slug>`.

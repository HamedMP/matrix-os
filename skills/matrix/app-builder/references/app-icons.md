# Matrix app icons

Preserve owner-provided artwork and a custom `system/desktop.json` `iconStyle`. Resolve the effective style with the Matrix icon generator's `loadIconStyle`: it treats the exact retired shipped clay default in older homes as the current Matrix desktop style, without replacing owner choices. For a new app without a requested style, use the Matrix desktop icon family. Its reference is the variety and legibility of Ubuntu/Yaru icons, not any copied Ubuntu artwork or mark.

## Design recipe

- Create one recognizable subject for the app's job. Vary silhouettes: circular timepiece, horizontal folder, tall document, irregular puzzle piece, window, globe, shield, or device. Do not give every icon the same rounded square tile.
- Use a transparent 1024×1024 canvas. Keep the subject within a roughly 80% safe area with a clear silhouette at 64, 48 and 20 pixels. Test over both light and dark desktop backgrounds.
- Choose rich color to distinguish adjacent apps: aubergine, orange, cobalt, teal, green, gold, and neutrals. A subject may use two main hues and one accent.
- Use restrained gradients, top-left highlights and a soft shadow for depth. Keep detail large enough to survive downscaling. Avoid a photograph, busy scene, fake text, logos, letters, or watermarks.
- Games need their own object: Chess gets a knight, Solitaire cards, Minesweeper a mine, Tetris blocks. The game controller belongs to Game Center.
- Store the exact final bytes in `~/system/icons/<manifest-icon>.png` and set `matrix.json` `icon` to that stem. Preview in Gallery, launcher, dock and a window tab. For first-party Gallery apps, keep Gallery and installed icon bytes identical.

## Prompt template

```text
Original Matrix desktop application icon for {APP}: {SPECIFIC_SUBJECT}.
Freestanding, recognizable silhouette on a transparent square canvas, centered with generous clear padding.
Mixed application silhouettes inspired by Ubuntu/Yaru clarity, without copying existing icon artwork.
Rich {PRIMARY} and {SECONDARY} colors with {ACCENT}; controlled top-left highlights,
subtle sculpted depth and a soft contact shadow. Big readable forms, few details.
No common beige square tile, text, letters, logos, watermark, scene or photorealism.
Readable at 48px and 20px over light and dark surfaces.
```

Preserve exact supplied Figma masters when the user chooses them. Do not silently replace an existing icon or change a user's saved icon style.

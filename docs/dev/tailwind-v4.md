# Tailwind CSS v4 Reference

## Key Differences from v3

- **No `tailwind.config.js`** -- all configuration happens in CSS
- **`@import "tailwindcss"`** replaces `@tailwind base/components/utilities`
- **`@plugin`** replaces `require()` in config for loading plugins
- **`@theme`** replaces `theme.extend` in config
- **`@utility`** replaces `@layer utilities` / `@layer components`
- **`@custom-variant`** replaces custom variant plugins

## Plugin Integration

V3 (old):
```js
// tailwind.config.js
module.exports = {
  plugins: [require("@tailwindcss/typography")],
};
```

V4 (current):
```css
/* globals.css */
@import "tailwindcss";
@plugin "@tailwindcss/typography";
```

## Typography Plugin -- Known Issue

`@tailwindcss/typography` works with v4 via `@plugin`, BUT pnpm's strict module isolation prevents `@tailwindcss/postcss` from resolving it in Docker. The PostCSS plugin resolves from its own virtual store (`node_modules/.pnpm/@tailwindcss+postcss@.../node_modules/@tailwindcss/`) which only sees `node`, `oxide`, `postcss` -- NOT `typography`.

**Our solution:** Custom `.md-prose` CSS class in `globals.css` instead of the typography plugin. This avoids all pnpm/Docker resolution issues and uses theme CSS variables for consistent styling.

## Other Changes

- `shadow-sm` -> `shadow-xs`, `shadow` -> `shadow-sm`
- `rounded-sm` -> `rounded-xs`, `rounded` -> `rounded-sm`
- `outline-none` -> `outline-hidden`
- `ring` -> `ring-3` (default width changed from 3px to 1px)
- Default border color changed from `gray-200` to `currentColor`
- Variant stacking order: left-to-right (was right-to-left)
- CSS variables: `bg-(--brand-color)` replaces `bg-[--brand-color]`
